import { describe, it, expect } from "vitest";
import { computeContainerStats } from "./docker.service";

describe("computeContainerStats", () => {
  it("computes CPU% (delta × cpus) and memory minus page cache", () => {
    const r = computeContainerStats({
      cpu_stats: {
        cpu_usage: { total_usage: 200_000_000 },
        system_cpu_usage: 1_000_000_000,
        online_cpus: 4,
      },
      precpu_stats: { cpu_usage: { total_usage: 100_000_000 }, system_cpu_usage: 600_000_000 },
      memory_stats: {
        usage: 9 * 1024 * 1024 * 1024,
        limit: 16 * 1024 * 1024 * 1024,
        stats: { inactive_file: 1 * 1024 * 1024 * 1024 },
      },
    });
    // cpuDelta=100M, sysDelta=400M → 0.25 → 25% of the whole machine (no × cores)
    expect(r?.cpuPercent).toBe(25);
    expect(r?.memUsedMb).toBe(8192); // 9 GB usage − 1 GB cache
    expect(r?.memLimitMb).toBe(16384);
  });

  it("clamps CPU to 0 when there's no usable delta, and handles missing fields", () => {
    const r = computeContainerStats({
      cpu_stats: { cpu_usage: { total_usage: 5 }, system_cpu_usage: 5, online_cpus: 2 },
      precpu_stats: { cpu_usage: { total_usage: 5 }, system_cpu_usage: 5 },
      memory_stats: { usage: 1048576, limit: 2097152 },
    });
    expect(r?.cpuPercent).toBe(0);
    expect(r?.memUsedMb).toBe(1);
  });

  it("returns null when memory stats are absent", () => {
    expect(computeContainerStats({})).toBeNull();
  });
});
