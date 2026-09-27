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
import { PrismaService } from "../prisma/prisma.service";
import { ManagerSettingsService, SettingKeys } from "../manager-settings/manager-settings.service";
import { AccessService } from "./access.service";

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

  /**
   * Sign in the user an SSO identity maps to, creating it on first sign-in. `role` is
   * the provider's say when group mapping is configured; null leaves roles to Palisade,
   * and new users then start as viewers.
   */
  async oidcSignIn(subject: string, username: string, role: Role | null): Promise<{ token: string }> {
    let user = await this.prisma.user.findUnique({ where: { oidcSubject: subject } });
    if (!user) {
      // Never adopt an existing account by name: a provider user could pick any username.
      if (await this.prisma.user.findUnique({ where: { username } })) {
        username = `${username}_${randomBytes(3).toString("hex")}`;
      }
      // The random password can never be typed, so this account only signs in through SSO.
      const passwordHash = await bcrypt.hash(randomBytes(32).toString("hex"), 12);
      user = await this.prisma.user.create({
        data: { username, passwordHash, role: role ?? "viewer", oidcSubject: subject },
      });
    } else if (role && role !== user.role && !(await this.isLastAdmin(user))) {
      await this.updateUser(user.id, { role });
      // Tokens carry the role, so sessions from before the change would keep the old one.
      await this.logoutAll(user.id);
      user = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    }
    return { token: await this.sign(user) };
  }

  /** Sign out the user an SSO identity signs in as, once the provider no longer grants it a role. */
  async oidcRevoke(subject: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { oidcSubject: subject } });
    if (user && !(await this.isLastAdmin(user))) await this.logoutAll(user.id);
  }

  /**
   * Let an existing user sign in through SSO from now on. `role` is what the provider's
   * groups grant; a link that would demote the account at its next SSO sign-in is refused.
   */
  async linkOidc(userId: string, subject: string, role: Role | null): Promise<void> {
    const owner = await this.prisma.user.findUnique({ where: { oidcSubject: subject }, select: { id: true } });
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
    await this.prisma.user.update({ where: { id: userId }, data: { oidcSubject: subject } });
  }

  /**
   * Stop an SSO identity signing in as this user. Unlinking yourself takes your password,
   * which an account created through SSO does not have, so nobody locks themselves out.
   */
  async unlinkOidc(userId: string, password?: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    if (password !== undefined && !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException(
        "Wrong password. An account created through SSO has none, so unlinking it would lock you out.",
      );
    }
    await this.prisma.user.update({ where: { id: userId }, data: { oidcSubject: null } });
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
