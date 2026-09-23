import { describe, it, expect } from "vitest";
import { BadRequestException, ValidationPipe } from "@nestjs/common";
import { EventType } from "@ark/shared";
import { PutTargetsBody } from "./notifications.controller";

// The same pipe main.ts installs globally.
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false });
const put = (url: string) =>
  pipe.transform(
    { targets: [{ id: "t1", name: "n", kind: "webhook", url, enabled: true, events: [EventType.Warning] }] },
    { type: "body", metatype: PutTargetsBody },
  );

describe("PUT /notifications URL validation", () => {
  it("rejects empty, non-URL and non-http(s) webhook URLs", async () => {
    for (const url of ["", "   ", "not a url", "discord.com/api/webhooks/1", "ftp://example.com/hook"]) {
      await expect(put(url), url).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it("accepts public and LAN http(s) URLs", async () => {
    for (const url of [
      "https://discord.com/api/webhooks/1/abc",
      "https://ntfy.sh/my-topic",
      "http://ntfy:8080/alerts",
      "http://192.168.1.20/hook",
    ]) {
      await expect(put(url), url).resolves.toBeInstanceOf(PutTargetsBody);
    }
  });
});
