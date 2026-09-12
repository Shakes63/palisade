import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import type { FirstRunDto, LoginDto, Role, UserAccessDto, UserDto } from "@ark/shared";
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
    if (!dto.username || dto.password.length < 8) {
      throw new BadRequestException("Username required and password must be 8+ chars");
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const user = await this.prisma.user.create({
      data: { username: dto.username, passwordHash, role: "admin" },
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
    createdAt: true,
    serverAccess: { select: { serverId: true } },
    clusterAccess: { select: { clusterId: true } },
  } as const;

  private static toDto(u: {
    id: string;
    username: string;
    role: string;
    restricted: boolean;
    createdAt: Date;
    serverAccess: { serverId: string }[];
    clusterAccess: { clusterId: string }[];
  }): UserDto {
    return {
      id: u.id,
      username: u.username,
      role: u.role as Role,
      restricted: u.role !== "admin" && u.restricted,
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

  async createUser(username: string, password: string, access: UserAccessDto = {}): Promise<UserDto> {
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
