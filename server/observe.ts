import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, lstat, open, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { jobId, receiptSchema, type Receipt } from "../shared/receipt";
import { observersSchema, type Observer } from "../shared/observer";

const OWNER = "paseo-fleet-jobs/automatic-observer/v1";
const MAX_CONFIG = 32 * 1024;
const MAX_RECEIPT = 32 * 1024;
const MAX_EVIDENCE = 2 * 1024 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
type ReadFile = { text: string; bytes: Buffer; mtimeMs: number };
type FileMetadata = { mtimeMs: number };
type Marker = { owner: typeof OWNER; id: string; configSha256: string };
type Result = { receipts: Receipt[]; warnings: string[] };

function rootFor(home?: string): string {
  return path.resolve(home ?? process.env.FLEET_JOBS_HOME ?? path.join(homedir(), ".paseo-fleet-jobs"));
}

function warning(error: unknown): string {
  return error instanceof Error ? error.message : "operation failed";
}

async function ensureDirectory(directory: string, parent: string): Promise<void> {
  try { await mkdir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("observer store must use real directories");
  const resolved = await realpath(directory);
  if (path.dirname(resolved) !== await realpath(parent)) throw new Error("observer store escapes configured home");
}

async function boundedText(file: string, maxBytes: number): Promise<ReadFile> {
  if (!path.isAbsolute(file)) throw new Error("configured artifact paths must be absolute");
  const absolute = path.resolve(file);
  const before = await lstat(absolute);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error("artifact is not a regular, non-symlink file");
  if (before.size > maxBytes) throw new Error("artifact exceeds size limit");
  if (await realpath(absolute) !== absolute) throw new Error("artifact path resolves through a symlink");
  const handle = await open(absolute, constants.O_RDONLY | NOFOLLOW);
  try {
    const first = await handle.stat();
    if (!first.isFile() || first.size > maxBytes) throw new Error("artifact is not a bounded regular file");
    const data = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    if (bytesRead > maxBytes) throw new Error("artifact exceeds size limit");
    const last = await handle.stat();
    if (last.size !== first.size || last.mtimeMs !== first.mtimeMs) throw new Error("artifact changed while it was read");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, bytesRead)); }
    catch { throw new Error("artifact is not valid UTF-8 text"); }
    return { text, bytes: data.subarray(0, bytesRead), mtimeMs: last.mtimeMs };
  } finally { await handle.close(); }
}

async function fileMetadata(file: string): Promise<FileMetadata> {
  if (!path.isAbsolute(file)) throw new Error("configured artifact paths must be absolute");
  const absolute = path.resolve(file);
  const before = await lstat(absolute);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error("artifact is not a regular, non-symlink file");
  if (await realpath(absolute) !== absolute) throw new Error("artifact path resolves through a symlink");
  const handle = await open(absolute, constants.O_RDONLY | NOFOLLOW);
  try {
    const first = await handle.stat();
    if (!first.isFile() || first.dev !== before.dev || first.ino !== before.ino) throw new Error("artifact changed while it was opened");
    const last = await handle.stat();
    if (last.dev !== first.dev || last.ino !== first.ino) throw new Error("artifact identity changed while it was observed");
    return { mtimeMs: last.mtimeMs };
  } finally { await handle.close(); }
}

async function readOwnedReceipt(file: string, id: string): Promise<Receipt> {
  const { text } = await boundedText(file, MAX_RECEIPT);
  let input: unknown;
  try { input = JSON.parse(text); } catch { throw new Error("owned receipt is invalid JSON"); }
  const parsed = receiptSchema.safeParse(input);
  if (!parsed.success || parsed.data.id !== id) throw new Error("owned receipt does not match its filename and schema");
  return parsed.data;
}

async function atomicWrite(file: string, text: string): Promise<void> {
  const pending = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.pending`);
  try {
    const handle = await open(pending, "wx", 0o600);
    try { await handle.writeFile(text, "utf8"); } finally { await handle.close(); }
    await rename(pending, file);
  } finally { await rm(pending, { force: true }); }
}

async function acquire(lock: string): Promise<() => Promise<void>> {
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("observer receipt is locked; inspect and remove a stale lock manually");
    throw error;
  }
  return () => rm(lock, { recursive: true, force: true });
}

async function withReceiptLocks<T>(receiptFile: string, stateFile: string, work: () => Promise<T>): Promise<T> {
  const releaseState = await acquire(`${stateFile}.lock`);
  let releaseReceipt: (() => Promise<void>) | undefined;
  try {
    releaseReceipt = await acquire(`${receiptFile}.lock`);
    return await work();
  } finally {
    if (releaseReceipt) await releaseReceipt();
    await releaseState();
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function configHash(observer: Observer): string {
  return createHash("sha256").update(canonical(observer)).digest("hex");
}

function observedDate(mtime: number, started: number): string {
  return new Date(Math.max(mtime, started)).toISOString();
}

function jsonField(value: unknown, fieldPath: string[]): unknown {
  let current = value;
  for (const segment of fieldPath) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === null || ["string", "number", "boolean"].includes(typeof current)) return current;
  return undefined;
}

async function observeOne(observer: Observer, jobs: string, states: string): Promise<{ receipt?: Receipt; warning?: string }> {
  const receiptFile = path.join(jobs, `${observer.id}.json`);
  const stateFile = path.join(states, `${observer.id}.json`);
  const start = Date.parse(observer.runStartedAt);
  const signature = configHash(observer);

  try {
    return await withReceiptLocks(receiptFile, stateFile, async () => {
      let marker: Marker | undefined;
      try {
        const { text } = await boundedText(stateFile, 4096);
        marker = JSON.parse(text) as Marker;
        if (marker.owner !== OWNER || marker.id !== observer.id || marker.configSha256 !== signature) {
          throw new Error("observer ownership marker does not match this exact configuration and run");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const existing = await lstatMaybe(receiptFile);
        if (existing) throw new Error("receipt exists without an observer ownership marker; refusing to overwrite it");
        marker = { owner: OWNER, id: observer.id, configSha256: signature };
        await atomicWrite(stateFile, `${JSON.stringify(marker)}\n`);
      }

      const receiptExists = await lstatMaybe(receiptFile);
      if (receiptExists) {
        const current = await readOwnedReceipt(receiptFile, observer.id);
        if (current.status === "succeeded" || current.status === "failed") return { receipt: current };
      }

      const warnings: string[] = [];
      let evidenceFile: ReadFile | undefined;
      let evidence: Receipt["evidence"];
      let evidenceInvalid = false;
      try {
        evidenceFile = await boundedText(observer.evidencePath, MAX_EVIDENCE);
        if (evidenceFile.mtimeMs >= start) {
          evidence = { path: path.resolve(observer.evidencePath), sha256: createHash("sha256").update(evidenceFile.bytes).digest("hex") };
        } else { evidenceInvalid = true; warnings.push("evidence is older than this run"); }
      } catch (error) {
        evidenceInvalid = (error as NodeJS.ErrnoException).code !== "ENOENT";
        warnings.push(`evidence unavailable: ${warning(error)}`);
      }

      let heartbeatAt: number | undefined;
      let heartbeatInvalid = false;
      if (observer.heartbeatPath) {
        try {
          const metadata = await fileMetadata(observer.heartbeatPath);
          if (metadata.mtimeMs >= start) heartbeatAt = metadata.mtimeMs;
          else warnings.push("heartbeat is older than this run");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") heartbeatInvalid = true;
          warnings.push(`heartbeat unavailable: ${warning(error)}`);
        }
      }
      let logAt: number | undefined;
      if (observer.logPath) {
        try {
          const metadata = await fileMetadata(observer.logPath);
          if (metadata.mtimeMs >= start) logAt = metadata.mtimeMs;
          else warnings.push("log is older than this run");
        } catch (error) { warnings.push(`log unavailable: ${warning(error)}`); }
      }

      let outcome: "succeeded" | "failed" | undefined;
      let outcomeInvalid = false;
      if (observer.outcome.kind === "unassessed") {
        // Evidence is still captured and hashed, but no acceptance result is inferred.
      } else if (evidence && evidenceFile) {
        if (observer.outcome.kind === "text") {
          const success = evidenceFile.text.includes(observer.outcome.successMarker);
          const failed = evidenceFile.text.includes(observer.outcome.failureMarker);
          if (success !== failed) outcome = success ? "succeeded" : "failed";
          else if (success) { outcomeInvalid = true; warnings.push("evidence contains both configured outcome markers"); }
        } else {
          try {
            const value: unknown = JSON.parse(evidenceFile.text);
            const field = jsonField(value, observer.outcome.fieldPath);
            if (field === observer.outcome.successValue) outcome = "succeeded";
            else if (field === observer.outcome.failureValue) outcome = "failed";
            else { outcomeInvalid = true; warnings.push("evidence outcome field is missing or unrecognized"); }
          } catch { outcomeInvalid = true; warnings.push("evidence is not valid JSON for the configured outcome rule"); }
        }
      }

      const status: Receipt["status"] = observer.outcome.kind === "unassessed"
        ? "unknown"
        : outcome ?? (outcomeInvalid || evidenceInvalid || heartbeatInvalid ? "unknown" : heartbeatAt !== undefined ? "running" : "waiting");
      const timestamp = status === "running" && heartbeatAt !== undefined
        ? Math.max(start, heartbeatAt)
        : Math.max(start, heartbeatAt ?? 0, evidenceFile?.mtimeMs ?? 0, observer.outcome.kind === "unassessed" ? logAt ?? 0 : 0);
      const candidate = receiptSchema.parse({
        schemaVersion: 1,
        id: observer.id,
        title: observer.title,
        ...(observer.project !== undefined ? { project: observer.project } : {}),
        ...(observer.owner !== undefined ? { owner: observer.owner } : {}),
        status,
        startedAt: observer.runStartedAt,
        updatedAt: observedDate(timestamp, start),
        staleAfterSeconds: observer.staleAfterSeconds,
        ...(status === "waiting" ? { waitingFor: "Configured result evidence is incomplete" } : {}),
        ...(evidence ? { evidence } : {}),
        ...(observer.logPath ? { logPath: path.resolve(observer.logPath) } : {}),
        ...(observer.outcome.kind === "unassessed"
          ? { message: "No acceptance verdict is configured; evidence is recorded without assessment" }
          : warnings.length ? { message: warnings.join("; ").slice(0, 2000) } : {}),
      });
      await atomicWrite(receiptFile, `${JSON.stringify(candidate, null, 2)}\n`);
      return { receipt: candidate, ...(warnings.length ? { warning: warnings.map((item) => `${observer.id}: ${item}`).join("; ") } : {}) };
    });
  } catch (error) { return { warning: `${observer.id}: ${warning(error)}` }; }
}

async function lstatMaybe(file: string) {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("receipt and observer state must be regular, non-symlink files");
    return info;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Collect receipts only from explicitly configured observers. */
export async function collectObservations(home?: string): Promise<Result> {
  const root = rootFor(home);
  const configFile = path.join(root, "observers.json");
  let raw: string;
  try {
    const configInfo = await lstat(configFile);
    if (configInfo.isSymbolicLink() || !configInfo.isFile() || configInfo.size > MAX_CONFIG) throw new Error("observers.json must be a regular file no larger than 32 KiB");
    const { text } = await boundedText(configFile, MAX_CONFIG);
    raw = text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { receipts: [], warnings: [] };
    return { receipts: [], warnings: [`Cannot read observers.json: ${warning(error)}`] };
  }
  let entries: unknown;
  try { entries = JSON.parse(raw); } catch { return { receipts: [], warnings: ["observers.json is not valid JSON"] }; }
  const parsed = observersSchema.safeParse(entries);
  if (!parsed.success) {
    if (parsed.error.issues.some((issue) => issue.message === "observer IDs must be unique")) return { receipts: [], warnings: ["observers.json contains duplicate IDs"] };
    return { receipts: [], warnings: ["observers.json does not match the observer schema or exceeds 32 entries"] };
  }

  const parent = root;
  try { await mkdir(parent, { recursive: true }); } catch { /* handled by directory checks */ }
  const jobs = path.join(root, "jobs");
  const states = path.join(root, "observer-state");
  try {
    await ensureDirectory(jobs, parent);
    await ensureDirectory(states, parent);
  } catch (error) { return { receipts: [], warnings: [`Cannot prepare observer store: ${warning(error)}`] }; }

  const receipts: Receipt[] = [];
  const warnings: string[] = [];
  for (const observer of parsed.data) {
    const result = await observeOne(observer, jobs, states);
    if (result.receipt) receipts.push(result.receipt);
    if (result.warning) warnings.push(result.warning);
  }
  return { receipts, warnings };
}
