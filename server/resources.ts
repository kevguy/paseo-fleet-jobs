import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, opendir, statfs } from "node:fs/promises";
import type { StatsFs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  resourceConfigSchema, resourceSnapshotSchema,
  type DiskResource, type GpuResource, type HeavyClaims, type ResourceConfig, type ResourceSnapshot,
} from "../shared/resources";

const FRESHNESS_SECONDS = 60;
const CONFIG_MAX_BYTES = 32 * 1024;
const CLAIM_FILE_MAX_BYTES = 8 * 1024;
const CLAIM_FILE_MAX_COUNT = 100;
const CLAIM_DIRECTORY_ENTRY_MAX = 1000;
const NVIDIA_SMI = "/usr/bin/nvidia-smi";
const GPU_QUERY = ["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"] as const;

type FsStats = StatsFs;

export type ResourceDependencies = {
  now?: () => Date;
  statfs?: (path: string) => Promise<FsStats>;
  runNvidiaSmi?: (file: string, args: readonly string[], options: { timeout: number; maxBuffer: number; windowsHide: boolean }) => Promise<string>;
  disableCache?: boolean;
};

const defaultRunNvidiaSmi: NonNullable<ResourceDependencies["runNvidiaSmi"]> = (file, args, options) =>
  new Promise((resolve, reject) => execFile(file, [...args], options, (error, stdout) => error ? reject(error) : resolve(stdout)));

const cache = new Map<string, { at: number; result: ResourceSnapshot }>();

function observation(status: "available" | "unavailable" | "unknown", now: Date, error: string | null = null) {
  return { status, observedAt: now.toISOString(), ageSeconds: 0, error };
}

async function within<T>(promise: Promise<T>, limitMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("Observation timed out")), limitMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function emptyGpu(now: Date): GpuResource {
  return { ...observation("unknown", now), reservationAvailability: "unknown", devices: [] };
}
function emptyClaims(now: Date): HeavyClaims {
  return {
    ...observation("unknown", now), unexpiredCount: 0, expiredCount: 0, unknownCount: 0,
    unexpiredWeight: 0, expiredWeight: 0, unknownWeight: 0,
  };
}

async function readBoundedRegularFile(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error("File outside bounded limits");
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new Error("File grew beyond bounded limits");
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function loadConfig(home: string): Promise<{ config: ResourceConfig | null; error: string | null }> {
  const path = join(home, "resources.json");
  try {
    const parsed = resourceConfigSchema.safeParse(JSON.parse(await readBoundedRegularFile(path, CONFIG_MAX_BYTES)));
    return parsed.success ? { config: parsed.data, error: null } : { config: null, error: "resources.json has invalid bounded configuration" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: null, error: null };
    if (error instanceof Error && error.message === "File outside bounded limits") return { config: null, error: "resources.json must be a regular file under 32 KiB" };
    return { config: null, error: "Cannot read resources.json" };
  }
}

async function readDisk(volume: ResourceConfig["volumes"][number], now: Date, statfsFn: NonNullable<ResourceDependencies["statfs"]>): Promise<DiskResource> {
  try {
    const stats = await within(statfsFn(volume.path), 2500);
    const blockSize = Number(stats.bsize);
    const total = Number(stats.blocks) * blockSize;
    const available = Number(stats.bavail) * blockSize;
    if (![blockSize, total, available].every(value => Number.isFinite(value) && value >= 0) || total <= 0) throw new Error();
    return {
      ...observation("available", now), id: volume.id, label: volume.label,
      totalBytes: total, availableBytes: Math.min(available, total),
      usedPercent: Math.max(0, Math.min(100, (1 - Math.min(available, total) / total) * 100)),
    };
  } catch {
    return {
      ...observation("unavailable", now, "Volume statistics unavailable"), id: volume.id, label: volume.label,
      totalBytes: null, availableBytes: null, usedPercent: null,
    };
  }
}

function parseGpu(stdout: string, now: Date): GpuResource {
  if (stdout.length > 16 * 1024) throw new Error("GPU output exceeded limit");
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length || lines.length > 16) throw new Error("GPU output was empty or exceeded device limit");
  const devices = lines.map(line => {
    const fields = line.split(",").map(value => value.trim());
    if (fields.length !== 4) throw new Error("GPU output format was invalid");
    if (!fields[0] || fields[0].length > 120 || fields.slice(1).some(field => field.length === 0)) throw new Error("GPU output values were invalid");
    const utilizationPercent = Number(fields[1]);
    const memoryUsedMib = Number(fields[2]);
    const memoryTotalMib = Number(fields[3]);
    if (!Number.isFinite(utilizationPercent) || utilizationPercent < 0 || utilizationPercent > 100 ||
        !Number.isFinite(memoryUsedMib) || memoryUsedMib < 0 || !Number.isFinite(memoryTotalMib) || memoryTotalMib <= 0 || memoryUsedMib > memoryTotalMib) {
      throw new Error("GPU output values were invalid");
    }
    return { name: fields[0], utilizationPercent, memoryUsedBytes: memoryUsedMib * 1024 * 1024, memoryTotalBytes: memoryTotalMib * 1024 * 1024 };
  });
  return { ...observation("available", now), reservationAvailability: "unknown", devices };
}

async function readGpu(enabled: boolean, now: Date, runner: NonNullable<ResourceDependencies["runNvidiaSmi"]>): Promise<GpuResource> {
  if (!enabled) return emptyGpu(now);
  let stdout: string;
  try {
    stdout = await runner(NVIDIA_SMI, GPU_QUERY, { timeout: 3000, maxBuffer: 16 * 1024, windowsHide: true });
  } catch {
    return { ...emptyGpu(now), status: "unavailable", error: "NVIDIA telemetry unavailable" };
  }
  try { return parseGpu(stdout, now); }
  catch { return { ...emptyGpu(now), error: "NVIDIA telemetry format unknown" }; }
}

const claimRecordSchema = z.object({
  started_at: z.string().max(100),
  ttl_min: z.number().positive().max(10080).optional(),
  weight: z.number().positive().max(100).optional(),
}).passthrough();

async function readClaims(directory: string | undefined, now: Date): Promise<HeavyClaims> {
  if (!directory) return emptyClaims(now);
  const result = { ...observation("available" as const, now), unexpiredCount: 0, expiredCount: 0, unknownCount: 0, unexpiredWeight: 0, expiredWeight: 0, unknownWeight: 0 };
  try {
    const dir = await opendir(directory);
    const selected: string[] = [];
    let entriesSeen = 0;
    let truncated = false;
    try {
      for await (const entry of dir) {
        if (entriesSeen++ >= CLAIM_DIRECTORY_ENTRY_MAX) { truncated = true; break; }
        if (entry.isFile() && /^[a-f0-9]{8}\.json$/i.test(entry.name)) {
          if (selected.length >= CLAIM_FILE_MAX_COUNT) { truncated = true; break; }
          selected.push(entry.name);
        }
      }
    } finally {
      await dir.close().catch(() => {});
    }
    if (truncated) {
      result.status = "unknown";
      result.error = "Claim directory exceeded the observation limit; totals are partial";
    }
    for (const entry of selected) {
      try {
        const raw = JSON.parse(await within(readBoundedRegularFile(join(directory, entry), CLAIM_FILE_MAX_BYTES), 2500)) as unknown;
        const parsed = claimRecordSchema.safeParse(raw);
        if (!parsed.success || !Number.isFinite(Date.parse(parsed.data.started_at))) throw new Error();
        const ttl = parsed.data.ttl_min ?? 120;
        const weight = parsed.data.weight ?? 1;
        if (Date.parse(parsed.data.started_at) + ttl * 60_000 > now.getTime()) {
          result.unexpiredCount++;
          result.unexpiredWeight += weight;
        } else {
          result.expiredCount++;
          result.expiredWeight += weight;
        }
      } catch {
        result.unknownCount++;
      }
    }
    return result;
  } catch {
    return { ...emptyClaims(now), status: "unavailable", error: "Claim directory unavailable" };
  }
}

function withAges(snapshot: ResourceSnapshot, age: number): ResourceSnapshot {
  const bump = <T extends { ageSeconds: number }>(value: T): T => ({ ...value, ageSeconds: age });
  return resourceSnapshotSchema.parse({
    ...snapshot, disks: snapshot.disks.map(bump), gpu: bump(snapshot.gpu), heavyClaims: bump(snapshot.heavyClaims),
  });
}

/**
 * Observe only explicitly configured local resources. Missing resources.json is normal and quiet.
 * Heavy claim "unexpired" means its timestamp/TTL window is open; PID liveness is deliberately not probed.
 */
export async function getResources(home?: string, dependencies: ResourceDependencies = {}): Promise<ResourceSnapshot> {
  const resolvedHome = home ?? process.env.FLEET_JOBS_HOME ?? join(homedir(), ".paseo-fleet-jobs");
  const nowFn = dependencies.now ?? (() => new Date());
  const now = nowFn();
  const cached = cache.get(resolvedHome);
  if (!dependencies.disableCache && cached && now.getTime() - cached.at < FRESHNESS_SECONDS * 1000) {
    return withAges(cached.result, Math.max(0, Math.floor((now.getTime() - cached.at) / 1000)));
  }
  const deps = {
    statfs: dependencies.statfs ?? statfs,
    runNvidiaSmi: dependencies.runNvidiaSmi ?? defaultRunNvidiaSmi,
  };
  const configResult = await loadConfig(resolvedHome);
  const observedAt = now.toISOString();
  const config = configResult.config;
  const [disks, gpu, heavyClaims] = config ? await Promise.all([
    Promise.all(config.volumes.map(volume => readDisk(volume, now, deps.statfs))),
    readGpu(config.gpuEnabled, now, deps.runNvidiaSmi),
    readClaims(config.heavySlotDirectory, now),
  ]) : [[], emptyGpu(now), emptyClaims(now)] as const;
  const snapshot = resourceSnapshotSchema.parse({
    configured: config !== null || configResult.error !== null,
    observedAt,
    freshnessSeconds: FRESHNESS_SECONDS,
    configurationError: configResult.error,
    disks,
    gpu,
    heavyClaims,
  });
  if (!dependencies.disableCache) cache.set(resolvedHome, { at: now.getTime(), result: snapshot });
  return snapshot;
}
