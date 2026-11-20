import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { hostname } from "node:os";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { detailSchema, jobId, receiptSchema, snapshotSchema, type Detail, type Job, type Receipt, type Snapshot } from "../shared/receipt";

const MAX_RECEIPT_BYTES = 32 * 1024;
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const DETAIL_TEXT_BYTES = 24 * 1024;
const MAX_RECEIPTS = 200;
const MAX_DIRECTORY_ENTRIES = 4000;
const MAX_CLOCK_SKEW_MS = 60_000;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

type Options = { directory?: string; now?: Date };
type ReadArtifact = { text: string | null; warning?: string };

function receiptDirectory(options?: Options): string {
  return resolve(options?.directory ?? join(process.env.FLEET_JOBS_HOME || join(homedir(), ".paseo-fleet-jobs"), "jobs"));
}

async function boundedFile(path: string, maxBytes: number): Promise<Buffer> {
  if (!isAbsolute(path)) throw new Error("artifact path must be absolute");
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("artifact is not a regular file");
  if (before.size > maxBytes) throw new Error("artifact exceeds size limit");
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("artifact is not a bounded regular file");
    const data = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    if (bytesRead > maxBytes) throw new Error("artifact exceeds size limit");
    return data.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

async function verifyEvidence(receipt: Receipt): Promise<{ verified: boolean; warning?: string; text?: string | null }> {
  if (!receipt.evidence) return { verified: false, warning: receipt.status === "succeeded" ? "receipt has no evidence artifact" : undefined };
  try {
    const data = await boundedFile(receipt.evidence.path, MAX_EVIDENCE_BYTES);
    const hash = createHash("sha256").update(data).digest("hex");
    if (hash !== receipt.evidence.sha256) return { verified: false, warning: "evidence SHA-256 does not match receipt" };
    return { verified: true, text: decodePreview(data) };
  } catch (error) {
    return { verified: false, warning: `evidence unavailable: ${errorMessage(error)}` };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "read failed";
}

function temporalIssue(receipt: Receipt, now: Date): string | undefined {
  const start = Date.parse(receipt.startedAt);
  const updated = Date.parse(receipt.updatedAt);
  if (start > now.getTime() + MAX_CLOCK_SKEW_MS || updated > now.getTime() + MAX_CLOCK_SKEW_MS) return "receipt timestamp is more than 60 seconds in the future";
  if (updated < start) return "updatedAt is earlier than startedAt";
  return undefined;
}

function decodePreview(data: Buffer): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  decoder.decode(data);
  let end = Math.min(data.length, DETAIL_TEXT_BYTES);
  while (end > 0) {
    try { return decoder.decode(data.subarray(0, end)); }
    catch { end--; }
  }
  return "";
}

async function toJob(receipt: Receipt, now: Date, suppliedEvidence?: Awaited<ReturnType<typeof verifyEvidence>>): Promise<{ job: Job; warning?: string }> {
  const temporal = temporalIssue(receipt, now);
  const evidence = suppliedEvidence ?? (receipt.evidence || receipt.status === "succeeded" ? await verifyEvidence(receipt) : { verified: false });
  let effectiveStatus: Job["effectiveStatus"] = receipt.status;
  let reason = `publisher reports ${receipt.status}`;
  if (temporal) {
    effectiveStatus = "unknown";
    reason = temporal;
  } else if (receipt.status === "running" || receipt.status === "waiting") {
    const age = (now.getTime() - Date.parse(receipt.updatedAt)) / 1000;
    if (age > receipt.staleAfterSeconds) {
      effectiveStatus = "stale";
      reason = `heartbeat is older than ${receipt.staleAfterSeconds} seconds`;
    }
  } else if (receipt.status === "succeeded" && !evidence.verified) {
    effectiveStatus = "unknown";
    reason = evidence.warning ?? "successful receipt lacks verified evidence";
  }
  const job = { ...receipt, effectiveStatus, reason, evidenceVerified: evidence.verified };
  return { job, warning: temporal ?? evidence.warning };
}

async function readReceipt(directory: string, filename: string): Promise<{ receipt: Receipt; path: string }> {
  const id = filename.slice(0, -5);
  if (!jobId.safeParse(id).success || filename !== `${id}.json`) throw new Error("unsafe receipt filename");
  const path = join(directory, filename);
  const data = await boundedFile(path, MAX_RECEIPT_BYTES);
  let value: unknown;
  try { value = JSON.parse(data.toString("utf8")); }
  catch { throw new Error("receipt is not valid JSON"); }
  const parsed = receiptSchema.safeParse(value);
  if (!parsed.success) throw new Error("receipt does not match the required schema");
  if (parsed.data.id !== id) throw new Error("receipt ID does not match filename");
  return { receipt: parsed.data, path };
}

async function listReceiptNames(directory: string): Promise<{ names: string[]; warnings: string[]; truncated: boolean }> {
  const names: string[] = [];
  const warnings: string[] = [];
  let entries = 0;
  let truncated = false;
  let handle;
  try { handle = await opendir(directory); }
  catch (error) { return { names, warnings: [`receipt directory unavailable: ${errorMessage(error)}`], truncated: false }; }
  try {
    for await (const entry of handle) {
      entries++;
      if (entry.name.endsWith(".json")) {
        names.push(entry.name);
        if (names.length >= MAX_RECEIPTS) { truncated = true; break; }
      }
      if (entries >= MAX_DIRECTORY_ENTRIES) { truncated = true; warnings.push("receipt directory scan reached its entry limit"); break; }
    }
  } catch (error) { warnings.push(`receipt directory could not be fully read: ${errorMessage(error)}`); }
  names.sort();
  return { names, warnings, truncated };
}

export async function getSnapshot(options?: Options): Promise<Snapshot> {
  const directory = receiptDirectory(options);
  const now = options?.now ?? new Date();
  const found = await listReceiptNames(directory);
  const jobs: Job[] = [];
  for (const name of found.names) {
    try {
      const { receipt } = await readReceipt(directory, name);
      const result = await toJob(receipt, now);
      jobs.push(result.job);
      if (result.warning) found.warnings.push(`${name}: ${result.warning}`);
    } catch (error) { found.warnings.push(`${name}: ${errorMessage(error)}`); }
  }
  const snapshot = { host: hostname(), observedAt: now.toISOString(), receiptDirectory: directory, jobs, warnings: found.warnings, truncated: found.truncated };
  return snapshotSchema.parse(snapshot);
}

async function readLogTail(path: string): Promise<ReadArtifact> {
  try {
    if (!isAbsolute(path)) throw new Error("artifact path must be absolute");
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("artifact is not a regular file");
    const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("artifact is not a regular file");
      const start = Math.max(0, stat.size - DETAIL_TEXT_BYTES);
      const data = Buffer.alloc(Math.min(DETAIL_TEXT_BYTES, stat.size));
      const { bytesRead } = await handle.read(data, 0, data.length, start);
      return { text: data.subarray(0, bytesRead).toString("utf8") };
    } finally { await handle.close(); }
  } catch (error) { return { text: null, warning: `log unavailable: ${errorMessage(error)}` }; }
}

export async function getDetail(id: string, options?: Options): Promise<Detail> {
  if (!jobId.safeParse(id).success) throw new Error("invalid job ID");
  const directory = receiptDirectory(options);
  const now = options?.now ?? new Date();
  const { receipt } = await readReceipt(directory, `${id}.json`);
  const evidence = await verifyEvidence(receipt);
  const { job, warning } = await toJob(receipt, now, evidence);
  const warnings: string[] = warning ? [warning] : [];
  const log = receipt.logPath ? await readLogTail(receipt.logPath) : { text: null };
  if (log.warning) warnings.push(log.warning);
  return detailSchema.parse({ job, evidenceText: evidence.verified ? evidence.text ?? null : null, logTail: log.text, warnings });
}
