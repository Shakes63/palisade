import { describe, it, expect, vi } from "vitest";
import { BadRequestException, ValidationPipe } from "@nestjs/common";
import { ReplicationBody, ReplicationController } from "./replication.controller";
import type { ReplicationConfig } from "./replication.service";

// The same pipe main.ts installs globally.
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false });
const parse = (body: Record<string, unknown>) =>
  pipe.transform(body, { type: "body", metatype: ReplicationBody }) as Promise<ReplicationBody>;

function makeController(stored: ReplicationConfig | null = null) {
  const replication = {
    getConfig: vi.fn(async () => stored),
    saveConfig: vi.fn(async () => undefined),
    sync: vi.fn(async () => ({ uploaded: 0, skipped: false })),
  };
  return { ctl: new ReplicationController(replication as never), replication };
}

const sftp = { enabled: true, kind: "sftp", dir: "/backups", host: "nas.local", port: 22 };

describe("PUT /replication", () => {
  it("rejects a non-numeric or out-of-range port", async () => {
    await expect(parse({ ...sftp, port: "abc" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(parse({ ...sftp, port: 70000 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects an enabled config with no destination directory or SFTP host", async () => {
    const { ctl, replication } = makeController();
    await expect(ctl.put(await parse({ ...sftp, dir: "  " }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(ctl.put(await parse({ ...sftp, host: " " }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(ctl.put(await parse({ enabled: true, kind: "local", dir: "" }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(replication.saveConfig).not.toHaveBeenCalled();
  });

  it("saves a disabled config without a destination, and trims what it stores", async () => {
    const { ctl, replication } = makeController();
    await ctl.put(await parse({ enabled: false, kind: "sftp", dir: "" }));
    await ctl.put(await parse({ ...sftp, dir: " /backups ", host: " nas.local " }));
    expect(replication.saveConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ dir: "/backups", host: "nas.local" }),
    );
  });
});

describe("POST /replication/sync", () => {
  it("reports a skipped sync when replication is off or unconfigured", async () => {
    for (const stored of [null, { enabled: false, kind: "local", dir: "/r" }, { enabled: true, kind: "local", dir: "" }]) {
      const { ctl, replication } = makeController(stored as ReplicationConfig | null);
      await expect(ctl.sync()).resolves.toMatchObject({ started: false });
      expect(replication.sync).not.toHaveBeenCalled();
    }
  });

  it("starts a sync when replication is enabled", async () => {
    const { ctl, replication } = makeController({ enabled: true, kind: "local", dir: "/r" });
    await expect(ctl.sync()).resolves.toEqual({ started: true });
    expect(replication.sync).toHaveBeenCalledOnce();
  });
});
