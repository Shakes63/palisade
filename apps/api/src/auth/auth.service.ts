import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { ROLE_RANK, type FirstRunDto, type LoginDto, type Role, type UserAccessDto, type UserDto } from "@ark/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ManagerSettingsService, SettingKeys } from "../manager-settings/manager-settings.service";
import { AccessService } from "./access.service";

export interface OidcIdentity {
  issuer: string;
  subject: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly settings: ManagerSettingsService,
    private readonly access: AccessService,
  ) {}

  async status(): Promise<{ initialized: boolean }> {
    const count = await this.prisma.user.count();
    return { initialized: count > 0 && (await this.settings.isInitialized()) };
  }

  /** First-run wizard: create the single admin + persist paths/API keys. */
  async firstRun(dto: FirstRunDto): Promise<{ token: string }> {
    const existing = await this.prisma.user.count();
    if (existing > 0) throw new BadRequestException("Already initialized");
    const username = dto.username.trim();
    if (!username || dto.password.length < 8) {
      throw new BadRequestException("Username required and password must be 8+ chars");
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const user = await this.prisma.user.create({
      data: { username, passwordHash, role: "admin" },
    });

    if (dto.dataDir) await this.settings.set(SettingKeys.DataDir, dto.dataDir);
    if (dto.timezone) await this.settings.set(SettingKeys.Timezone, dto.timezone);
    if (dto.curseForgeApiKey)
      await this.settings.set(SettingKeys.CurseForgeApiKey, dto.curseForgeApiKey);
    if (dto.steamWebApiKey)
      await this.settings.set(SettingKeys.SteamWebApiKey, dto.steamWebApiKey);
    await this.settings.markInitialized();

    return { token: await this.sign(user) };
  }

  async login(dto: LoginDto): Promise<{ token: string }> {
    const user = await this.prisma.user.findUnique({ where: { username: dto.username } });
    if (!user) throw new UnauthorizedException("Invalid credentials");
    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) throw new UnauthorizedException("Invalid credentials");
    return { token: await this.sign(user) };
  }

  /** Sign in the user an SSO identity maps to. `role` is what the provider's groups grant, if it manages roles. */
  async oidcSignIn(id: OidcIdentity, username: string, role: Role | null, create: boolean): Promise<{ token: string }> {
    let user = await this.findByOidc(id);
    if (!user) {
      if (!create) {
        throw new ForbiddenException(
          "No Palisade account is linked to this SSO account. Sign in with your password and link it from " +
            "the account menu, or ask an admin to let SSO create accounts.",
        );
      }
      user = await this.createOidcUser(id, username, role);
    } else if (role && role !== user.role && !(await this.isLastAdmin(user))) {
      await this.updateUser(user.id, { role });
      // Tokens carry the role, so sessions from before the change would keep the old one.
      await this.logoutAll(user.id);
      user = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    }
    return { token: await this.sign(user) };
  }

  /** Sign out the user an SSO identity signs in as, once the provider no longer grants it a role. */
  async oidcRevoke(id: OidcIdentity): Promise<void> {
    const user = await this.findByOidc(id);
    if (user && !(await this.isLastAdmin(user))) await this.logoutAll(user.id);
  }

  /** Let an existing user sign in through SSO, unless their groups would demote them at the next SSO sign-in. */
  async linkOidc(userId: string, id: OidcIdentity, role: Role | null): Promise<void> {
    const owner = await this.findByOidc(id);
    if (owner && owner.id !== userId) {
      throw new ConflictException("That SSO account already signs in as a different Palisade user");
    }
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const current = user.role as Role;
    if (role && ROLE_RANK[role] < ROLE_RANK[current]) {
      throw new ForbiddenException(
        `Your SSO groups grant the ${role} role, so this ${current} account would become ${role} at its ` +
          `next SSO sign-in. Add your SSO account to the ${current} group at the provider first.`,
      );
    }
    await this.prisma.user.update({ where: { id: userId }, data: { oidcIssuer: id.issuer, oidcSubject: id.subject } });
  }

  /** Stop an SSO identity signing in as this user. Unlinking yourself takes your password. */
  async unlinkOidc(userId: string, password?: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    if (!user.hasPassword) {
      throw new BadRequestException(
        "This account was created through SSO and has no password, so unlinking SSO would lock it out. " +
          "Delete the user instead.",
      );
    }
    if (password !== undefined && !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException("Wrong password");
    }
    await this.prisma.user.update({ where: { id: userId }, data: { oidcIssuer: null, oidcSubject: null } });
  }

  private findByOidc(id: OidcIdentity) {
    return this.prisma.user.findFirst({ where: { oidcIssuer: id.issuer, oidcSubject: id.subject } });
  }

  private async createOidcUser(id: OidcIdentity, name: string, role: Role | null) {
    // The random password can never be typed, so this account only signs in through SSO.
    const passwordHash = await bcrypt.hash(randomBytes(32).toString("hex"), 12);
    for (let attempt = 1; ; attempt++) {
      // Never adopt an existing account by name: a provider user could pick any username.
      const taken = await this.prisma.user.findUnique({ where: { username: name } });
      const username = taken ? `${name}_${randomBytes(3).toString("hex")}` : name;
      try {
        return await this.prisma.user.create({
          data: {
            username,
            passwordHash,
            hasPassword: false,
            // Without group mapping anyone the provider lets in lands here, so they see nothing until granted.
            role: role ?? "viewer",
            restricted: role === null,
            oidcIssuer: id.issuer,
            oidcSubject: id.subject,
          },
        });
      } catch (e) {
        // A second callback for the same identity (double click, two tabs) may have created it first.
        const existing = await this.findByOidc(id);
        if (existing) return existing;
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") || attempt === 3) throw e;
      }
    }
  }

  private async isLastAdmin(user: { id: string; role: string }): Promise<boolean> {
    return (
      user.role === "admin" &&
      (await this.prisma.user.count({ where: { role: "admin", id: { not: user.id } } })) === 0
    );
  }

  /** Reject tokens whose `ver` claim no longer matches the user's tokenVersion. */
  async isTokenCurrent(sub: unknown, ver: unknown): Promise<boolean> {
    return (await this.resolveToken(sub, ver)) !== null;
  }

  /**
   * The per-request user lookup: null when the token is revoked or the user is
   * gone, otherwise the DB-backed bits the guards need. `restricted` rides along
   * so per-server access (GH #73) is read fresh on every request rather than
   * frozen into the JWT at login.
   */
  async resolveToken(sub: unknown, ver: unknown): Promise<{ restricted: boolean } | null> {
    if (typeof sub !== "string" || typeof ver !== "number") return null;
    const user = await this.prisma.user.findUnique({
      where: { id: sub },
      select: { tokenVersion: true, restricted: true },
    });
    if (user === null || user.tokenVersion !== ver) return null;
    return { restricted: user.restricted };
  }

  /** Invalidate every outstanding token for this user. */
  async logoutAll(userId: string): Promise<{ ok: true }> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    });
    return { ok: true };
  }

  private sign(user: { id: string; username: string; role: string; tokenVersion: number }): Promise<string> {
    return this.jwt.signAsync(
      { sub: user.id, username: user.username, role: user.role, ver: user.tokenVersion },
      { expiresIn: "7d" },
    );
  }

  // ── User management ────────────────────────────────────────────────────────

  private static readonly USER_SELECT = {
    id: true,
    username: true,
    role: true,
    restricted: true,
    hasPassword: true,
    oidcSubject: true,
    createdAt: true,
    serverAccess: { select: { serverId: true } },
    clusterAccess: { select: { clusterId: true } },
  } as const;

  private static toDto(u: {
    id: string;
    username: string;
    role: string;
    restricted: boolean;
    hasPassword: boolean;
    oidcSubject: string | null;
    createdAt: Date;
    serverAccess: { serverId: string }[];
    clusterAccess: { clusterId: string }[];
  }): UserDto {
    return {
      id: u.id,
      username: u.username,
      role: u.role as Role,
      restricted: u.role !== "admin" && u.restricted,
      sso: u.oidcSubject !== null,
      hasPassword: u.hasPassword,
      serverIds: u.serverAccess.map((a) => a.serverId),
      clusterIds: u.clusterAccess.map((a) => a.clusterId),
      createdAt: u.createdAt.toISOString(),
    };
  }

  async listUsers(): Promise<UserDto[]> {
    const rows = await this.prisma.user.findMany({
      select: AuthService.USER_SELECT,
      orderBy: { createdAt: "asc" },
    });
    return rows.map(AuthService.toDto);
  }

  async me(id: string): Promise<UserDto> {
    const row = await this.prisma.user.findUnique({ where: { id }, select: AuthService.USER_SELECT });
    if (!row) throw new UnauthorizedException("Token revoked");
    return AuthService.toDto(row);
  }

  async createUser(rawUsername: string, password: string, access: UserAccessDto = {}): Promise<UserDto> {
    const username = rawUsername.trim();
    if (!username || password.length < 8) {
      throw new BadRequestException("Username required and password must be 8+ chars");
    }
    const exists = await this.prisma.user.findUnique({ where: { username } });
    if (exists) throw new BadRequestException("Username already taken");
    const passwordHash = await bcrypt.hash(password, 12);
    // Least privilege by default: an omitted role used to mean admin.
    const role: Role = access.role ?? "operator";
    const restricted = role !== "admin" && (access.restricted ?? false);
    const user = await this.prisma.user.create({
      data: {
        username,
        passwordHash,
        role,
        restricted,
        serverAccess: { create: (restricted ? access.serverIds ?? [] : []).map((serverId) => ({ serverId })) },
        clusterAccess: {
          create: (restricted ? access.clusterIds ?? [] : []).map((clusterId) => ({ clusterId })),
        },
      },
      select: AuthService.USER_SELECT,
    });
    return AuthService.toDto(user);
  }

  /**
   * Edit role and/or per-server access (GH #73). Omitted fields are left alone;
   * `serverIds`/`clusterIds`, when present, REPLACE the existing grants. Refuses
   * to leave the panel without an unrestricted admin.
   */
  async updateUser(id: string, access: UserAccessDto): Promise<UserDto> {
    const current = await this.prisma.user.findUnique({ where: { id }, select: { role: true } });
    if (!current) throw new NotFoundException("User not found");
    const role = (access.role ?? current.role) as Role;
    if (current.role === "admin" && role !== "admin") await this.assertAnotherAdmin(id);

    // Admins are never restricted: promoting to admin clears the flag and
    // grants so nothing stale lingers if they are later demoted.
    const isAdmin = role === "admin";
    const serverIds = isAdmin ? [] : access.serverIds;
    const clusterIds = isAdmin ? [] : access.clusterIds;
    const restricted = isAdmin ? false : access.restricted;

    const user = await this.prisma.$transaction(async (tx) => {
      if (serverIds) {
        await tx.userServerAccess.deleteMany({ where: { userId: id } });
        await tx.userServerAccess.createMany({
          data: [...new Set(serverIds)].map((serverId) => ({ userId: id, serverId })),
        });
      }
      if (clusterIds) {
        await tx.userClusterAccess.deleteMany({ where: { userId: id } });
        await tx.userClusterAccess.createMany({
          data: [...new Set(clusterIds)].map((clusterId) => ({ userId: id, clusterId })),
        });
      }
      return tx.user.update({
        where: { id },
        data: { role, ...(restricted !== undefined ? { restricted } : {}) },
        select: AuthService.USER_SELECT,
      });
    });
    this.access.notifyChanged(id);
    return AuthService.toDto(user);
  }

  async deleteUser(id: string) {
    const count = await this.prisma.user.count();
    if (count <= 1) throw new BadRequestException("Cannot delete the last user");
    const target = await this.prisma.user.findUnique({ where: { id }, select: { role: true } });
    if (!target) throw new NotFoundException("User not found");
    if (target.role === "admin") await this.assertAnotherAdmin(id);
    await this.prisma.user.delete({ where: { id } });
    this.access.notifyChanged(id);
    return { ok: true };
  }

  /** Someone other than `exceptId` must remain an admin, or nobody could manage users. */
  private async assertAnotherAdmin(exceptId: string): Promise<void> {
    const others = await this.prisma.user.count({ where: { role: "admin", id: { not: exceptId } } });
    if (others === 0) throw new BadRequestException("At least one admin must remain");
  }
}
