#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, mkdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { receiptSchema, jobId, type Receipt } from "../shared/receipt";
import { getDetail, getSnapshot } from "../server/store";

const MAX_RECEIPT = 32 * 1024;
const MAX_EVIDENCE = 2 * 1024 * 1024;
const help = `Fleet Jobs receipt CLI

Usage:
  fleet-jobs record <receipt.json> [--replace]
  fleet-jobs heartbeat <id> [--message TEXT] [--progress 0..100] [--status running|waiting|failed|unknown]
  fleet-jobs finish <id> --status succeeded|failed --evidence PATH [--message TEXT]
  fleet-jobs snapshot
  fleet-jobs detail <id>
  fleet-jobs where
  fleet-jobs --help

Receipts are stored in <home>/jobs/<id>.json. Home defaults to ~/.paseo-fleet-jobs,
or can be set with FLEET_JOBS_HOME or --home PATH. Evidence paths are resolved
from the input receipt directory for record and from the current directory for finish.
Record and finish verify a regular, non-symlink evidence file (maximum 2 MiB) and
store its SHA-256. Terminal receipts cannot be changed; start a rerun with a new id.
This CLI only records job state. It never launches, stops, or executes jobs.`;

function fail(message: string): never { throw new Error(message); }
function validId(value: string): string {
  if (!jobId.safeParse(value).success) fail(`Invalid job id: ${value}`);
  return value;
}

function options(args: string[], valued: string[], booleans: string[] = []): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    if (flags.has(arg)) fail(`Repeated option ${arg}`);
    if (valued.includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) fail(`${arg} requires a value`);
      flags.set(arg, value);
    } else if (booleans.includes(arg)) flags.set(arg, true);
    else fail(`Unknown option ${arg}`);
  }
  return { positional, flags };
}

function homeFrom(args: string[]): { home: string; args: string[] } {
  const result: string[] = [];
  let home = process.env.FLEET_JOBS_HOME || path.join(homedir(), ".paseo-fleet-jobs");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--home") {
      const value = args[++i];
      if (!value || value.startsWith("--")) fail("--home requires a path");
      home = value;
    } else result.push(args[i]!);
  }
  return { home: path.resolve(home), args: result };
}

async function ensureStore(home: string): Promise<string> {
  await mkdir(home, { recursive: true });
  const homeReal = await realpath(home);
  const jobs = path.join(homeReal, "jobs");
  try { await mkdir(jobs); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  const info = await lstat(jobs);
  if (!info.isDirectory() || info.isSymbolicLink()) fail("Jobs store must be a real directory");
  const jobsReal = await realpath(jobs);
  if (path.dirname(jobsReal) !== homeReal) fail("Jobs store escapes configured home");
  return jobsReal;
}

async function regularFile(file: string, maxBytes?: number): Promise<{ file: string; size: number }> {
  const absolute = path.resolve(file);
  const entry = await lstat(absolute);
  if (!entry.isFile() || entry.isSymbolicLink()) fail(`Expected a regular, non-symlink file: ${absolute}`);
  const canonical = await realpath(absolute);
  if (canonical !== absolute) fail(`File path resolves through a symlink: ${absolute}`);
  const info = await stat(absolute);
  if (maxBytes !== undefined && info.size > maxBytes) fail(`File exceeds ${maxBytes} bytes`);
  return { file: absolute, size: info.size };
}

async function boundedText(file: string, maxBytes: number): Promise<string> {
  const checked = await regularFile(file, maxBytes);
  const handle = await open(checked.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) fail(`File exceeds ${maxBytes} bytes or is not a regular file`);
    const bytes = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maxBytes) fail(`File exceeds ${maxBytes} bytes`);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
  } finally { await handle.close(); }
}

async function digestEvidence(inputPath: string): Promise<{ path: string; sha256: string }> {
  const checked = await regularFile(inputPath, MAX_EVIDENCE);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(checked.file, constants.O_RDONLY | noFollow);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_EVIDENCE) fail(`Evidence exceeds ${MAX_EVIDENCE} bytes or is not a regular file`);
    const data = Buffer.alloc(MAX_EVIDENCE + 1);
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    if (bytesRead > MAX_EVIDENCE) fail(`Evidence exceeds ${MAX_EVIDENCE} bytes`);
    const bytes = data.subarray(0, bytesRead);
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { fail("Evidence must be valid UTF-8 text"); }
    return { path: checked.file, sha256: createHash("sha256").update(bytes).digest("hex") };
  } finally { await handle.close(); }
}

async function assertNoSymlinkIfExists(file: string): Promise<boolean> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) fail(`Receipt path must be a regular, non-symlink file: ${file}`);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

async function atomicWrite(file: string, data: string): Promise<void> {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.pending`);
  try {
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(data, "utf8"); } finally { await handle.close(); }
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}

async function withLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") fail(`Receipt is locked (${lock}); inspect and remove a stale lock manually`);
    throw e;
  }
  try { return await work(); } finally { await rm(lock, { recursive: true, force: true }); }
}

async function readReceipt(file: string, id: string): Promise<Receipt> {
  if (!(await assertNoSymlinkIfExists(file))) fail(`No receipt found for ${id}`);
  let parsed: unknown;
  try { parsed = JSON.parse(await boundedText(file, MAX_RECEIPT)); } catch { fail(`Could not read a bounded UTF-8 receipt for ${id}`); }
  const result = receiptSchema.safeParse(parsed);
  if (!result.success) fail(`Stored receipt is invalid: ${result.error.issues.map((x) => x.message).join("; ")}`);
  if (result.data.id !== id) fail("Receipt id does not match its filename");
  return result.data;
}

async function record(home: string, args: string[]): Promise<void> {
  const { positional, flags } = options(args, [], ["--replace"]);
  if (positional.length !== 1) fail("record requires exactly one receipt path");
  const source = await regularFile(positional[0]!, MAX_RECEIPT);
  let input: any;
  try { input = JSON.parse(await boundedText(source.file, MAX_RECEIPT)); } catch { fail("Input receipt must be bounded valid UTF-8 JSON"); }
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("Input receipt must be a JSON object");
  if (input.evidence !== undefined) {
    if (!input.evidence || typeof input.evidence.path !== "string") fail("Evidence requires a path");
    input.evidence = await digestEvidence(path.resolve(path.dirname(source.file), input.evidence.path));
  }
  if (typeof input.logPath === "string") input.logPath = path.resolve(path.dirname(source.file), input.logPath);
  const parsed = receiptSchema.safeParse(input);
  if (!parsed.success) fail(`Invalid receipt: ${parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
  const receipt = parsed.data;
  if (receipt.status === "succeeded" && !receipt.evidence) fail("A succeeded receipt requires a verified evidence artifact");
  const jobs = await ensureStore(home);
  const file = path.join(jobs, `${receipt.id}.json`);
  await withLock(file, async () => {
    const exists = await assertNoSymlinkIfExists(file);
    if (exists && flags.get("--replace") !== true) fail(`Receipt ${receipt.id} already exists (use --replace to replace a nonterminal receipt)`);
    if (exists) {
      const current = await readReceipt(file, receipt.id);
      if (["succeeded", "failed"].includes(current.status)) fail("Cannot replace a terminal receipt");
    }
    await atomicWrite(file, `${JSON.stringify(receipt, null, 2)}\n`);
  });
  console.log(file);
}

async function heartbeat(home: string, args: string[]): Promise<void> {
  const { positional, flags } = options(args, ["--message", "--progress", "--status"]);
  if (positional.length !== 1) fail("heartbeat requires exactly one id");
  const id = validId(positional[0]!);
  if (flags.has("--status") && !["running", "waiting", "failed", "unknown"].includes(String(flags.get("--status")))) fail("Invalid heartbeat status");
  let progress: number | undefined;
  if (flags.has("--progress")) {
    progress = Number(flags.get("--progress"));
    if (!Number.isFinite(progress) || progress < 0 || progress > 100) fail("Progress must be between 0 and 100");
  }
  const file = path.join(await ensureStore(home), `${id}.json`);
  await withLock(file, async () => {
    const receipt = await readReceipt(file, id);
    if (["succeeded", "failed"].includes(receipt.status)) fail("Cannot update a terminal receipt");
    if (flags.has("--message")) receipt.message = String(flags.get("--message"));
    if (progress !== undefined) receipt.progress = progress;
    if (flags.has("--status")) receipt.status = String(flags.get("--status")) as Receipt["status"];
    receipt.updatedAt = new Date().toISOString();
    const validated = receiptSchema.parse(receipt);
    await atomicWrite(file, `${JSON.stringify(validated, null, 2)}\n`);
  });
  console.log(`Updated ${id}`);
}

async function finish(home: string, args: string[]): Promise<void> {
  const { positional, flags } = options(args, ["--status", "--evidence", "--message"]);
  if (positional.length !== 1) fail("finish requires exactly one id");
  const id = validId(positional[0]!);
  const status = flags.get("--status");
  if (status !== "succeeded" && status !== "failed") fail("finish requires --status succeeded|failed");
  const evidenceArg = flags.get("--evidence");
  if (typeof evidenceArg !== "string") fail("finish requires --evidence PATH");
  const evidence = await digestEvidence(path.resolve(evidenceArg));
  const file = path.join(await ensureStore(home), `${id}.json`);
  await withLock(file, async () => {
    const receipt = await readReceipt(file, id);
    if (["succeeded", "failed"].includes(receipt.status)) fail("Cannot finish a terminal receipt");
    receipt.status = status;
    receipt.evidence = evidence;
    if (flags.has("--message")) receipt.message = String(flags.get("--message"));
    receipt.updatedAt = new Date().toISOString();
    const validated = receiptSchema.parse(receipt);
    await atomicWrite(file, `${JSON.stringify(validated, null, 2)}\n`);
  });
  console.log(`Finished ${id} as ${status}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.length === 0) { console.log(help); return; }
  const { home, args } = homeFrom(argv);
  const command = args.shift();
  if (command === "where") {
    if (args.length) fail("where takes no arguments");
    console.log(path.join(home, "jobs")); return;
  }
  if (command === "snapshot") {
    if (args.length) fail("snapshot takes no arguments");
    console.log(JSON.stringify(await getSnapshot({ directory: path.join(home, "jobs") })));
    return;
  }
  if (command === "detail") {
    if (args.length !== 1) fail("detail requires exactly one id");
    console.log(JSON.stringify(await getDetail(validId(args[0]!), { directory: path.join(home, "jobs") })));
    return;
  }
  if (command === "record") return record(home, args);
  if (command === "heartbeat") return heartbeat(home, args);
  if (command === "finish") return finish(home, args);
  fail(`Unknown command: ${command}\n\n${help}`);
}

main().catch((error: unknown) => {
  console.error(`fleet-jobs: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
