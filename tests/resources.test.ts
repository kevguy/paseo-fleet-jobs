import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { getResources } from "../server/resources";
import { resourceConfigSchema, resourceSnapshotSchema } from "../shared/resources";

const archive = process.env.FLEET_JOBS_TEST_ROOT || resolve(".validation/resources-tests");

async function home(label: string): Promise<string> {
  await mkdir(archive, { recursive: true });
  const path = await mkdtemp(join(archive, `${label}-`));
  return path;
}

async function configAt(root: string, config: unknown) {
  await writeFile(join(root, "resources.json"), JSON.stringify(config));
}

describe("resource observation configuration", () => {
  it("accepts only bounded explicit volumes, a fixed GPU toggle and an absolute claim directory", () => {
    assert.equal(resourceConfigSchema.safeParse({ volumes: [{ id: "system", label: "System", path: "/" }], gpuEnabled: true, heavySlotDirectory: "/var/run/heavy-slots" }).success, true);
    assert.equal(resourceConfigSchema.safeParse({ volumes: [{ id: "system", label: "System", path: "*" }] }).success, false);
    assert.equal(resourceConfigSchema.safeParse({ gpuCommand: "arbitrary command" }).success, false);
    assert.equal(resourceConfigSchema.safeParse({ volumes: Array.from({ length: 9 }, (_, i) => ({ id: `disk-${i}`, label: "Disk", path: "/" })) }).success, false);
    assert.equal(resourceConfigSchema.safeParse({ volumes: [{ id: "same", label: "One", path: "/a" }, { id: "same", label: "Two", path: "/b" }] }).success, false);
  });

  it("quietly reports unconfigured resources when resources.json is absent", async () => {
    const root = await home("absent");
    const result = await getResources(root, { disableCache: true });
    assert.equal(result.configured, false);
    assert.equal(result.configurationError, null);
    assert.equal(result.disks.length, 0);
    assert.equal(result.gpu.status, "unknown");
    assert.equal(result.gpu.reservationAvailability, "unknown");
    assert.equal(result.heavyClaims.status, "unknown");
  });

  it("keeps malformed configuration errors bounded and private paths out of output", async () => {
    const root = await home("invalid");
    await configAt(root, { volumes: [{ id: "bad", label: "Disk", path: "relative/private/path" }] });
    const result = await getResources(root, { disableCache: true });
    assert.equal(result.configured, true);
    assert.equal(result.configurationError, "resources.json has invalid bounded configuration");
    assert.equal(JSON.stringify(result).includes("relative/private/path"), false);
  });

  it("does not follow a config symlink", async () => {
    const root = await home("symlink-config");
    const target = join(root, "target.json");
    await writeFile(target, JSON.stringify({ volumes: [{ id: "system", label: "System", path: "/" }] }));
    await symlink(target, join(root, "resources.json"));
    const result = await getResources(root, { disableCache: true });
    assert.equal(result.configured, true);
    assert.equal(result.configurationError, "Cannot read resources.json");
    assert.equal(result.disks.length, 0);
  });
});

describe("bounded read-only resource observations", () => {
  it("reads explicit disk stats and fixed nvidia-smi telemetry while keeping reservations unknown", async () => {
    const root = await home("available");
    await configAt(root, { volumes: [{ id: "system", label: "System", path: "/synthetic/system" }], gpuEnabled: true });
    let gpuInvocation: { file: string; args: readonly string[]; options: { timeout: number; maxBuffer: number; windowsHide: boolean } } | undefined;
    const result = await getResources(root, {
      disableCache: true,
      now: () => new Date("2026-11-20T10:00:00.000Z"),
      statfs: async path => {
        assert.equal(path, "/synthetic/system");
        return { bsize: 1024, blocks: 1000, bavail: 250 } as import("node:fs").StatsFs;
      },
      runNvidiaSmi: async (file, args, options) => {
        gpuInvocation = { file, args, options };
        return "NVIDIA Example, 17, 512, 8192\n";
      },
    });
    assert.equal(result.disks[0]?.status, "available");
    assert.equal(result.disks[0]?.totalBytes, 1_024_000);
    assert.equal(result.disks[0]?.availableBytes, 256_000);
    assert.equal(result.disks[0]?.usedPercent, 75);
    assert.equal(result.gpu.status, "available");
    assert.equal(result.gpu.devices[0]?.utilizationPercent, 17);
    assert.equal(result.gpu.reservationAvailability, "unknown");
    assert.deepEqual(gpuInvocation, {
      file: "/usr/bin/nvidia-smi",
      args: ["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"],
      options: { timeout: 3000, maxBuffer: 16 * 1024, windowsHide: true },
    });
    assert.equal(resourceSnapshotSchema.safeParse(result).success, true);
    assert.equal(JSON.stringify(result).includes("/synthetic/system"), false);
  });

  it("aggregates only claim counts and weights with timestamp-based expiry", async () => {
    const root = await home("claims");
    const claims = join(root, "claim-fixtures");
    await mkdir(claims);
    await writeFile(join(claims, "a1b2c3d4.json"), JSON.stringify({ id: "a1b2c3d4", pid: 4567, session: "private-session", purpose: "private purpose", weight: 0.5, ttl_min: 60, started_at: "2026-11-20T09:30:00+00:00", machine: "fixture" }));
    await writeFile(join(claims, "b1b2c3d4.json"), JSON.stringify({ id: "b1b2c3d4", pid: 4568, weight: 1, ttl_min: 10, started_at: "2026-11-20T09:00:00+00:00" }));
    await writeFile(join(claims, "c1b2c3d4.json"), "not-json");
    await configAt(root, { heavySlotDirectory: claims });
    const result = await getResources(root, { disableCache: true, now: () => new Date("2026-11-20T10:00:00.000Z") });
    assert.equal(result.heavyClaims.status, "available");
    assert.equal(result.heavyClaims.unexpiredCount, 1);
    assert.equal(result.heavyClaims.unexpiredWeight, 0.5);
    assert.equal(result.heavyClaims.expiredCount, 1);
    assert.equal(result.heavyClaims.expiredWeight, 1);
    assert.equal(result.heavyClaims.unknownCount, 1);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("private-session"), false);
    assert.equal(serialized.includes("private purpose"), false);
    assert.equal(serialized.includes("4567"), false);
  });

  it("marks over-limit claim observations unknown and does not report free capacity", async () => {
    const root = await home("claim-limit");
    const claims = join(root, "claim-fixtures");
    await mkdir(claims);
    const claim = JSON.stringify({ started_at: "2026-11-20T09:30:00+00:00", ttl_min: 60, weight: 0.5 });
    await Promise.all(Array.from({ length: 101 }, (_, i) => writeFile(join(claims, `${i.toString(16).padStart(8, "0")}.json`), claim)));
    await configAt(root, { heavySlotDirectory: claims });
    const result = await getResources(root, { disableCache: true, now: () => new Date("2026-11-20T10:00:00.000Z") });
    assert.equal(result.heavyClaims.status, "unknown");
    assert.equal(result.heavyClaims.unexpiredCount, 100);
    assert.match(result.heavyClaims.error ?? "", /totals are partial/);
    assert.equal("availableCapacity" in result.heavyClaims, false);
  });

  it("marks malformed GPU rows unknown instead of coercing blanks or impossible memory values", async () => {
    for (const [label, row] of [["blank", "NVIDIA Example, , 1, 8"], ["over", "NVIDIA Example, 20, 9, 8"]] as const) {
      const root = await home(`gpu-${label}`);
      await configAt(root, { gpuEnabled: true });
      const result = await getResources(root, { disableCache: true, runNvidiaSmi: async () => row });
      assert.equal(result.gpu.status, "unknown");
      assert.equal(result.gpu.devices.length, 0);
      assert.equal(result.gpu.reservationAvailability, "unknown");
    }
  });

  it("preserves partial failures and caches observations for at most one minute", async () => {
    const root = await home("partial");
    const claims = join(root, "missing-claims");
    await configAt(root, { volumes: [{ id: "missing", label: "Missing", path: "/unavailable" }], gpuEnabled: true, heavySlotDirectory: claims });
    let calls = 0;
    let clock = new Date("2026-11-20T10:00:00.000Z");
    const dependencies = {
      now: () => clock,
      statfs: async () => { calls++; throw new Error("private OS path"); },
      runNvidiaSmi: async () => { calls++; throw new Error("private process error"); },
    };
    const first = await getResources(root, dependencies);
    assert.equal(first.disks[0]?.status, "unavailable");
    assert.equal(first.gpu.status, "unavailable");
    assert.equal(first.heavyClaims.status, "unavailable");
    assert.equal(first.disks[0]?.error, "Volume statistics unavailable");
    assert.equal(first.gpu.error, "NVIDIA telemetry unavailable");
    assert.equal(JSON.stringify(first).includes("private OS path"), false);
    clock = new Date("2026-11-20T10:00:30.000Z");
    const cached = await getResources(root, dependencies);
    assert.equal(calls, 2);
    assert.equal(cached.disks[0]?.ageSeconds, 30);
    clock = new Date("2026-11-20T10:01:01.000Z");
    await getResources(root, dependencies);
    assert.equal(calls, 4);
  });
});
