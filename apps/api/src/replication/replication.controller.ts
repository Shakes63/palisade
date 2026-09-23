import { BadRequestException, Body, Controller, Get, Post, Put } from "@nestjs/common";
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { ReplicationService, type ReplicationConfig } from "./replication.service";
import { MinRole } from "../auth/min-role.decorator";

export class ReplicationBody {
  @IsBoolean() enabled!: boolean;
  @IsIn(["sftp", "local"]) kind!: "sftp" | "local";
  @IsString() @MaxLength(1000) dir!: string;
  @IsOptional() @IsString() @MaxLength(255) host?: string;
  @IsOptional() @IsInt() @Min(1) @Max(65535) port?: number;
  @IsOptional() @IsString() @MaxLength(255) username?: string;
  /** Blank = keep the currently stored secret. */
  @IsOptional() @IsString() @MaxLength(1000) password?: string;
  @IsOptional() @IsString() @MaxLength(20000) privateKey?: string;
}

@MinRole("admin")
@Controller("replication")
export class ReplicationController {
  constructor(private readonly replication: ReplicationService) {}

  /** Config with secrets reported as presence booleans, plus sync status. */
  @Get()
  async view() {
    const config = await this.replication.getConfig();
    const status = await this.replication.getStatus();
    return {
      config: config
        ? {
            enabled: config.enabled,
            kind: config.kind,
            dir: config.dir,
            host: config.host ?? "",
            port: config.port ?? 22,
            username: config.username ?? "",
            hasPassword: Boolean(config.password),
            hasPrivateKey: Boolean(config.privateKey),
          }
        : null,
      status,
    };
  }

  @Put()
  async put(@Body() body: ReplicationBody) {
    const dir = body.dir.trim();
    const host = body.host?.trim() || undefined;
    if (body.enabled && !dir) {
      throw new BadRequestException("Enter a destination directory, or turn replication off.");
    }
    if (body.enabled && body.kind === "sftp" && !host) {
      throw new BadRequestException("Enter the SFTP host, or turn replication off.");
    }
    const prev = await this.replication.getConfig();
    const next: ReplicationConfig = {
      enabled: body.enabled,
      kind: body.kind,
      dir,
      host,
      port: body.port,
      username: body.username,
      // Blank secret fields keep whatever is already stored.
      password: body.password || prev?.password,
      privateKey: body.privateKey || prev?.privateKey,
    };
    await this.replication.saveConfig(next);
    return { ok: true };
  }

  @Post("test")
  test() {
    return this.replication.test();
  }

  /** Kicks a sync off in the background — a full pass can take minutes with
   *  large snapshots, far past proxy timeouts. Poll GET / for status. */
  @Post("sync")
  async sync(): Promise<{ started: boolean; message?: string }> {
    const config = await this.replication.getConfig();
    if (!config?.enabled || !config.dir) {
      return { started: false, message: "Replication is off or has no destination. Enable it and save first." };
    }
    void this.replication.sync().catch(() => undefined);
    return { started: true };
  }
}
