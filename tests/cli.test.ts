import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archive = process.env.FLEET_JOBS_TEST_ROOT || path.resolve(".validation/cli-tests");
let sandbox = "";
let home = "";
let sourceDir = "";

before(async () => {
  await mkdir(archive, { recursive: true });
  sandbox = await mkdtemp(path.join(archive, "run-"));
  home = path.join(sandbox, "home");
  sourceDir = path.join(sandbox, "inputs with spaces");
  await mkdir(sourceDir);
});

after(async () => { if (sandbox) await rm(sandbox, { recursive: true, force: true }); });

function cli(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/cli.ts", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, FLEET_JOBS_HOME: home },
  });
}

async function inputReceipt(id: string, evidence?: string, logPath?: string, status = "running") {
  const file = path.join(sourceDir, `${id}.json`);
  await writeFile(file, JSON.stringify({
    schemaVersion: 1, id, title: `Synthetic ${id}`, status,
    startedAt: "2026-11-20T00:00:00.000Z", updatedAt: "2026-11-20T00:00:00.000Z",
    ...(evidence ? { evidence: { path: evidence } } : {}),
    ...(logPath ? { logPath } : {}),
  }));
  return file;
}

test("records, heartbeats, verifies fresh evidence, and refuses terminal rewrites", async () => {
  const artifact = path.join(sourceDir, "result.txt");
  const log = path.join(sourceDir, "run.log");
  const bytes = "synthetic artifact\n";
  await writeFile(artifact, bytes);
  await writeFile(log, "synthetic log tail\n");
  const input = await inputReceipt("cli-happy-path", "result.txt", "run.log");
  let result = cli("record", input);
  assert.equal(result.status, 0, result.stderr);
  const receiptFile = path.join(home, "jobs", "cli-happy-path.json");
  let receipt = JSON.parse(await readFile(receiptFile, "utf8"));
  assert.equal(receipt.evidence.path, artifact);
  assert.equal(receipt.evidence.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(receipt.logPath, log);

  result = cli("heartbeat", "cli-happy-path", "--message", "still running", "--progress", "41", "--status", "waiting");
  assert.equal(result.status, 0, result.stderr);
  receipt = JSON.parse(await readFile(receiptFile, "utf8"));
  assert.equal(receipt.message, "still running");
  assert.equal(receipt.progress, 41);
  assert.equal(receipt.status, "waiting");
  assert.notEqual(receipt.updatedAt, "2026-11-20T00:00:00.000Z");

  result = cli("finish", "cli-happy-path", "--status", "succeeded", "--evidence", artifact);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(receiptFile, "utf8")).status, "succeeded");
  result = cli("heartbeat", "cli-happy-path", "--status", "running");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /terminal receipt/);
});

test("rejects unsafe IDs, missing success artifacts, and replacement of terminal receipts", async () => {
  let result = cli("heartbeat", "../escape");
  assert.notEqual(result.status, 0);
  result = cli("finish", "missing-job", "--status", "succeeded", "--evidence", path.join(sourceDir, "absent"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENOENT|no such file/i);

  const input = await inputReceipt("cli-terminal-replace");
  assert.equal(cli("record", input).status, 0);
  const artifact = path.join(sourceDir, "replacement-evidence.txt");
  await writeFile(artifact, "synthetic");
  assert.equal(cli("finish", "cli-terminal-replace", "--status", "failed", "--evidence", artifact).status, 0);
  result = cli("record", input, "--replace");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /terminal receipt/);
});

test("where and read-only snapshot/detail return JSON from the configured home", async () => {
  const result = cli("where");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), path.join(home, "jobs"));
  const snapshotResult = cli("snapshot");
  assert.equal(snapshotResult.status, 0, snapshotResult.stderr);
  assert.ok(Array.isArray(JSON.parse(snapshotResult.stdout).jobs));
  const detailResult = cli("detail", "cli-happy-path");
  assert.equal(detailResult.status, 0, detailResult.stderr);
  const detail = JSON.parse(detailResult.stdout);
  assert.equal(detail.job.id, "cli-happy-path");
  assert.equal(detail.evidenceText, "synthetic artifact\n");
  assert.equal(detail.logTail, "synthetic log tail\n");
});

test("rejects invalid UTF-8 evidence and options that do not belong to heartbeat", async () => {
  const artifact = path.join(sourceDir, "invalid-utf8.bin");
  await writeFile(artifact, Buffer.from([0xc3, 0x28]));
  const successInput = await inputReceipt("cli-invalid-utf8", "invalid-utf8.bin", undefined, "succeeded");
  let result = cli("record", successInput);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /valid UTF-8/);

  const runningInput = await inputReceipt("cli-invalid-finish");
  assert.equal(cli("record", runningInput).status, 0);
  result = cli("finish", "cli-invalid-finish", "--status", "failed", "--evidence", artifact);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /valid UTF-8/);

  result = cli("heartbeat", "cli-invalid-finish", "--replace");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown option/);

  await writeFile(path.join(home, "jobs", "oversized-receipt.json"), " ".repeat(33 * 1024));
  result = cli("heartbeat", "oversized-receipt");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bounded UTF-8 receipt/);
});
