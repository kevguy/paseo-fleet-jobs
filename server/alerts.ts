import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { alertSchema, type JobAlert, type MonitorSnapshot } from "../shared/alerts";
import type { Job } from "../shared/receipt";

const stateSchema = z.object({
  version: z.literal(1), collectedAt: z.iso.datetime({ offset: true }),
  jobs: z.array(z.object({ key: z.string().max(200), seen: z.array(z.string().max(30)).max(12) }).strict()).max(400),
  alerts: z.array(alertSchema).max(100), warnings: z.array(z.string().max(500)).max(100),
}).strict();
type State = z.infer<typeof stateSchema>;
const MAX_BYTES = 512 * 1024;

async function readState(home: string): Promise<State | null> {
  let file;
  try { file = await open(join(home, "monitor.json"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Invalid monitor state file");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_BYTES) throw new Error("Monitor state exceeds size limit");
    return stateSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead))));
  } finally { await file.close(); }
}

// One receipt/run/state produces at most one alert, including across reloads.
// The first observation establishes a baseline instead of alerting on old history.
export async function recordTransitions(home: string, jobs: Job[], warnings: string[], now = new Date()): Promise<JobAlert[]> {
  const previous = await readState(home);
  const known = new Map(previous?.jobs.map(j => [j.key, new Set(j.seen)]) ?? []);
  const alerts = previous?.alerts ?? [];
  const added: JobAlert[] = [];
  for (const job of jobs) {
    const key = `${job.id}:${job.startedAt}`;
    const seen = known.get(key) ?? new Set<string>();
    const state = job.effectiveStatus;
    if (previous && !seen.has(state) && state !== "running") {
      const id = createHash("sha256").update(`${key}:${state}`).digest("hex");
      const alert = alertSchema.parse({ id, jobId: job.id, title: job.title, status: state, observedAt: now.toISOString(), reason: job.reason.slice(0, 2000) });
      added.push(alert);
    }
    seen.add(state);
    known.delete(key); known.set(key, seen);
  }
  const next = stateSchema.parse({ version: 1, collectedAt: now.toISOString(),
    jobs: [...known].slice(-400).map(([key, seen]) => ({ key, seen: [...seen] })),
    alerts: [...added.reverse(), ...alerts].slice(0, 100), warnings: warnings.slice(0, 100).map(w => w.slice(0, 500)) });
  const pending = join(home, `.monitor-${randomUUID()}.pending`);
  try {
    const file = await open(pending, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(next)); } finally { await file.close(); }
    await rename(pending, join(home, "monitor.json"));
  } finally { await rm(pending, { force: true }); }
  return added;
}

export async function readMonitor(home: string): Promise<MonitorSnapshot> {
  try {
    const state = await readState(home);
    let lockWarning: string | null = null;
    try {
      const lock = await lstat(join(home, "monitor.lock"));
      if (Date.now() - lock.mtimeMs > 180_000) lockWarning = "Collection lock is older than three minutes; inspect the collector before removing it.";
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") lockWarning = "Cannot inspect collection lock."; }
    return { lastCollectedAt: state?.collectedAt ?? null, alerts: state?.alerts ?? [], warnings: state?.warnings ?? [], error: lockWarning };
  } catch { return { lastCollectedAt: null, alerts: [], warnings: [], error: "Cannot read monitor state; collection will not replace invalid state." }; }
}

export async function withMonitorLock<T>(home: string, action: () => Promise<T>): Promise<T | null> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const info = await lstat(home);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Data home must be a real directory");
  const lock = join(home, "monitor.lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return null; throw e; }
  try {
    const owner = await open(join(lock, "owner.json"), "wx", 0o600);
    try { await owner.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); } finally { await owner.close(); }
    return await action();
  } finally { await rm(lock, { recursive: true, force: true }); }
}
