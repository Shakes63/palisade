import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventType, type NotificationTarget } from "@ark/shared";
import { NotificationsService } from "./notifications.service";

// The dispatcher: targets subscribe to event types and each kind has its own
// wire format. Fetch is stubbed; we assert on what would hit the network.
function makeService(stored: Record<string, string | null>) {
  const settings = {
    get: async (key: string) => stored[key] ?? null,
    set: async (key: string, value: string) => {
      stored[key] = value;
    },
  };
  const events = { onEvent: () => undefined };
  const svc = new NotificationsService(events as never, settings as never);
  return { svc, stored };
}

const target = (over: Partial<NotificationTarget>): NotificationTarget => ({
  id: "t1",
  name: "Test",
  kind: "discord",
  url: "https://example.com/hook",
  enabled: true,
  events: [EventType.Warning],
  ...over,
});

describe("NotificationsService", () => {
  const calls: { url: string; init: RequestInit }[] = [];
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200 } as Response;
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("migrates a legacy Discord webhook into a target once", async () => {
    const { svc, stored } = makeService({ discord_webhook_url: "https://discord/legacy" });
    const targets = await svc.getTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]!.kind).toBe("discord");
    expect(targets[0]!.url).toBe("https://discord/legacy");
    // Persisted — subsequent reads come from the new setting.
    expect(stored.notification_targets).toContain("legacy-discord");
  });

  it("returns [] with nothing configured", async () => {
    const { svc } = makeService({});
    expect(await svc.getTargets()).toEqual([]);
  });

  it("formats per kind: discord content, slack text, ntfy headers, webhook JSON", async () => {
    const { svc } = makeService({
      notification_targets: JSON.stringify([
        target({ id: "d", kind: "discord" }),
        target({ id: "s", kind: "slack" }),
        target({ id: "n", kind: "ntfy" }),
        target({ id: "w", kind: "webhook" }),
      ]),
    });
    for (const id of ["d", "s", "n", "w"]) {
      const res = await svc.test(id);
      expect(res.sent, id).toBe(true);
    }
    const [d, s, n, w] = calls;
    expect(JSON.parse(d!.init.body as string).content).toMatch(/^\*\*\[Warning\]\*\*/);
    expect(JSON.parse(s!.init.body as string).text).toMatch(/^\[Warning\]/);
    expect((n!.init.headers as Record<string, string>).Title).toContain("Palisade");
    expect((n!.init.headers as Record<string, string>).Priority).toBe("high");
    const generic = JSON.parse(w!.init.body as string);
    expect(generic.source).toBe("palisade");
    expect(generic.type).toBe(EventType.Warning);
  });

  it("test() reports failure without throwing", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 404 }) as Response);
    const { svc } = makeService({
      notification_targets: JSON.stringify([target({})]),
    });
    const res = await svc.test("t1");
    expect(res.sent).toBe(false);
    expect(res.error).toContain("404");
  });
});
