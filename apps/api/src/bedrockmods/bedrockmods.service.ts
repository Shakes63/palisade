import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { mkdir, readdir, readFile, writeFile, rm, cp } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { Game } from "@ark/shared";
import { PrismaService } from "../prisma/prisma.service";
import { LocalPaths } from "../common/paths";
import { loadEnv } from "../config/env";

const execFileP = promisify(execFile);

type PackType = "behavior" | "resource";
interface PackInfo {
  uuid: string;
  name: string;
  version: [number, number, number];
  type: PackType;
}

/**
 * Bedrock add-on installer. A .mcpack is one pack; a .mcaddon bundles several — both
 * are renamed zips. Installing a pack means: unzip it, read each manifest.json for
 * its UUID + version + type, copy it into behavior_packs/ or resource_packs/, and
 * ACTIVATE it by adding {pack_id, version} to the world's world_behavior_packs.json /
 * world_resource_packs.json (worlds/world — LEVEL_NAME is fixed to "world"). The
 * Bedrock server rebuilds valid_known_packs.json itself from the folders on start.
 * Everything we create is chowned to the runtime user (the itzg server runs as
 * env.PUID/PGID and must read the packs + write the world). Takes effect on restart.
 */
@Injectable()
export class BedrockModsService {
  private readonly logger = new Logger(BedrockModsService.name);

  constructor(private readonly prisma: PrismaService) {}

  private async bedrockServer(id: string) {
    const s = await this.prisma.server.findUnique({ where: { id } });
    if (!s) throw new NotFoundException("Server not found");
    if (s.game !== Game.BEDROCK) throw new BadRequestException("Add-ons are Bedrock-only here");
    return s;
  }

  private root(id: string): string {
    return LocalPaths.instanceRoot(id);
  }
  private packDir(id: string, type: PackType): string {
    return join(this.root(id), type === "behavior" ? "behavior_packs" : "resource_packs");
  }
  private worldDir(id: string): string {
    return join(this.root(id), "worlds", "world");
  }
  private worldPackFile(id: string, type: PackType): string {
    return join(this.worldDir(id), type === "behavior" ? "world_behavior_packs.json" : "world_resource_packs.json");
  }

  /** Installed add-on packs (folders under behavior_packs/ + resource_packs/). */
  async status(id: string) {
    await this.bedrockServer(id);
    const packs: Array<{ uuid: string; name: string; type: PackType }> = [];
    for (const type of ["behavior", "resource"] as PackType[]) {
      let entries: string[] = [];
      try {
        entries = await readdir(this.packDir(id, type));
      } catch {
        /* folder not created yet */
      }
      for (const folder of entries) {
        const info = await this.readManifest(join(this.packDir(id, type), folder)).catch(() => null);
        if (info) packs.push({ uuid: info.uuid, name: info.name, type });
      }
    }
    return { packs };
  }

  /** Install a .mcpack / .mcaddon (or a .zip of packs): unzip, register each pack. */
  async addPack(id: string, filename: string, data: Buffer) {
    await this.bedrockServer(id);
    const safe = basename(filename);
    if (!/\.(mcpack|mcaddon|zip)$/i.test(safe)) {
      throw new BadRequestException("Upload a .mcpack or .mcaddon");
    }
    const staging = join(tmpdir(), `bedrockmod-${process.pid}-${Date.now()}`);
    await mkdir(staging, { recursive: true });
    try {
      await this.unzip(data, staging);
      const packs = await this.findPacks(staging);
      if (packs.length === 0) {
        throw new BadRequestException("No Bedrock pack (manifest.json) found in the upload");
      }
      for (const { dir, info } of packs) {
        const dest = join(this.packDir(id, info.type), info.uuid);
        await rm(dest, { recursive: true, force: true });
        await mkdir(dirname(dest), { recursive: true });
        await cp(dir, dest, { recursive: true });
        await this.activateInWorld(id, info);
      }
      await this.ownForRuntime(id);
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
    return this.status(id);
  }

  /** Remove a pack by UUID: delete its folder + de-register it from the world. */
  async removePack(id: string, uuid: string) {
    await this.bedrockServer(id);
    const safe = basename(uuid); // UUIDs have no slashes, but stay defensive
    for (const type of ["behavior", "resource"] as PackType[]) {
      await rm(join(this.packDir(id, type), safe), { recursive: true, force: true });
      await this.rewriteWorldPacks(id, type, (list) => list.filter((e) => e.pack_id !== safe));
    }
    return this.status(id);
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /** Add {pack_id, version} to the world's activation list (idempotent). */
  private async activateInWorld(id: string, info: PackInfo) {
    await mkdir(this.worldDir(id), { recursive: true });
    await this.rewriteWorldPacks(id, info.type, (list) =>
      list.some((e) => e.pack_id === info.uuid) ? list : [...list, { pack_id: info.uuid, version: info.version }],
    );
  }

  private async rewriteWorldPacks(
    id: string,
    type: PackType,
    fn: (list: Array<{ pack_id: string; version: number[] }>) => Array<{ pack_id: string; version: number[] }>,
  ) {
    const file = this.worldPackFile(id, type);
    let list: Array<{ pack_id: string; version: number[] }> = [];
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      /* missing or malformed — start fresh */
    }
    const next = fn(list);
    if (JSON.stringify(next) === JSON.stringify(list)) return;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(next, null, 2));
  }

  /** Recursively find every pack (a dir containing a manifest.json) under `root`. */
  private async findPacks(root: string): Promise<Array<{ dir: string; info: PackInfo }>> {
    const out: Array<{ dir: string; info: PackInfo }> = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: import("node:fs").Dirent[] = [];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      if (entries.some((e) => e.isFile() && e.name === "manifest.json")) {
        const info = await this.readManifest(dir).catch(() => null);
        if (info) out.push({ dir, info });
        return; // a pack folder — don't descend into it
      }
      for (const e of entries) if (e.isDirectory()) await walk(join(dir, e.name));
    };
    await walk(root);
    return out;
  }

  /** Parse a pack's manifest.json → uuid/name/version/type. */
  private async readManifest(dir: string): Promise<PackInfo> {
    const raw = await readFile(join(dir, "manifest.json"), "utf8");
    // Some manifests ship with a UTF-8 BOM; strip it so JSON.parse doesn't choke.
    const m = JSON.parse(raw.replace(/^﻿/, ""));
    const header = m?.header ?? {};
    const uuid = String(header.uuid ?? "");
    if (!uuid) throw new BadRequestException("Pack manifest is missing a UUID");
    const modules: Array<{ type?: string }> = Array.isArray(m?.modules) ? m.modules : [];
    const type: PackType = modules.some((mod) => mod.type === "resources") ? "resource" : "behavior";
    return {
      uuid,
      name: typeof header.name === "string" ? header.name : uuid,
      version: this.toTriple(header.version),
      type,
    };
  }

  private toTriple(v: unknown): [number, number, number] {
    if (Array.isArray(v)) return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0];
    if (typeof v === "string") {
      const p = v.split(".").map((n) => Number(n) || 0);
      return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
    }
    return [0, 0, 0];
  }

  /** The itzg server runs as env.PUID/PGID; chown what we created so it can read the
   *  packs and write the world (a root-owned worlds/ dir would crash the server). */
  private async ownForRuntime(id: string) {
    const env = loadEnv();
    const owner = `${env.PUID}:${env.PGID}`;
    for (const dir of [this.packDir(id, "behavior"), this.packDir(id, "resource"), join(this.root(id), "worlds")]) {
      await execFileP("chown", ["-R", owner, dir]).catch((e) =>
        this.logger.warn(`chown ${dir} failed: ${(e as Error).message}`),
      );
    }
  }

  private async unzip(data: Buffer, dest: string) {
    const tmp = join(tmpdir(), `bedrockmod-zip-${process.pid}-${Date.now()}.zip`);
    await writeFile(tmp, data);
    try {
      await execFileP("unzip", ["-o", tmp, "-d", dest]);
    } catch (e) {
      throw new BadRequestException(`Could not unzip the upload: ${(e as Error).message}`);
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  }
}
