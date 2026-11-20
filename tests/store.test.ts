import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, lstat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { before, describe, it } from "node:test";
import { getDetail, getSnapshot } from "../server/store";

const archive = resolve(process.env.FLEET_JOBS_TEST_ROOT || ".validation/store-tests");
let root: string;
const fixedNow = new Date("2026-11-20T12:00:00.000Z");
const evidenceText = "verified evaluation output\n";
const hash = createHash("sha256").update(evidenceText).digest("hex");

async function setup(): Promise<string> {
  const directory = join(root, `case-${Math.random().toString(36).slice(2)}`);
  await mkdir(directory, { recursive: true });
  return directory;
}
function receipt(id: string, overrides: Record<string, unknown> = {}) {
  return { schemaVersion: 1, id, title: "Test job", status: "succeeded", startedAt: "2026-11-20T11:00:00.000Z", updatedAt: "2026-11-20T11:59:00.000Z", staleAfterSeconds: 900, evidence: { path: join(root, "evidence.txt"), sha256: hash }, ...overrides };
}
async function put(dir: string, id: string, value: unknown, filename = `${id}.json`) {
  await writeFile(join(dir, filename), JSON.stringify(value));
}

before(async () => {
  await mkdir(archive, { recursive: true });
  root = await mkdtemp(join(archive, "store-tests-"));
  await writeFile(join(root, "evidence.txt"), evidenceText);
});
describe("read-only receipt store", () => {
  it("verifies successful evidence and provides bounded detail", async () => {
    const dir = await setup();
    await put(dir, "good", receipt("good"));
    const snapshot = await getSnapshot({ directory: dir, now: fixedNow });
    assert.equal(snapshot.jobs[0]?.effectiveStatus, "succeeded");
    assert.equal(snapshot.jobs[0]?.evidenceVerified, true);
    const detail = await getDetail("good", { directory: dir, now: fixedNow });
    assert.equal(detail.evidenceText, evidenceText);
  });

  it("keeps optional evidence off active job warnings", async () => {
    const dir = await setup();
    await put(dir, "running", receipt("running", { status: "running", evidence: undefined }));
    await put(dir, "waiting", receipt("waiting", { status: "waiting", evidence: undefined }));
    const snapshot = await getSnapshot({ directory: dir, now: fixedNow });
    assert.deepEqual(snapshot.jobs.map(j => j.effectiveStatus), ["running", "waiting"]);
    assert.deepEqual(snapshot.warnings, []);
    const detail = await getDetail("running", { directory: dir, now: fixedNow });
    assert.equal(detail.job.evidenceVerified, false);
    assert.deepEqual(detail.warnings, []);
  });

  it("preserves valid UTF-8 when the preview byte limit falls inside a character", async () => {
    const dir = await setup();
    const content = "a".repeat(24 * 1024 - 1) + "😀" + "tail";
    const evidencePath = join(root, "utf8-evidence.txt");
    await writeFile(evidencePath, content);
    await put(dir, "utf8", receipt("utf8", { evidence: { path: evidencePath, sha256: createHash("sha256").update(content).digest("hex") } }));
    const detail = await getDetail("utf8", { directory: dir, now: fixedNow });
    assert.equal(detail.job.effectiveStatus, "succeeded");
    assert.equal(detail.job.evidenceVerified, true);
    assert.equal(detail.evidenceText, "a".repeat(24 * 1024 - 1));
    assert.deepEqual(detail.warnings, []);
  });

  it("does not mark missing or changed evidence successful", async () => {
    const dir = await setup();
    await put(dir, "missing", receipt("missing", { evidence: { path: join(root, "absent.txt"), sha256: hash } }));
    await put(dir, "changed", receipt("changed", { evidence: { path: join(root, "evidence.txt"), sha256: "0".repeat(64) } }));
    const { jobs } = await getSnapshot({ directory: dir, now: fixedNow });
    assert.deepEqual(jobs.map(j => j.effectiveStatus), ["unknown", "unknown"]);
  });

  it("rejects oversized evidence while preserving failed status", async () => {
    const dir = await setup();
    const largeEvidence = join(root, "oversized-evidence.txt");
    await writeFile(largeEvidence, "x".repeat(2 * 1024 * 1024 + 1));
    await put(dir, "large-evidence", receipt("large-evidence", { evidence: { path: largeEvidence, sha256: "f".repeat(64) } }));
    await put(dir, "failed-evidence", receipt("failed-evidence", { status: "failed", evidence: { path: largeEvidence, sha256: "f".repeat(64) } }));
    const { jobs } = await getSnapshot({ directory: dir, now: fixedNow });
    assert.equal(jobs.find(j => j.id === "large-evidence")?.effectiveStatus, "unknown");
    assert.equal(jobs.find(j => j.id === "failed-evidence")?.effectiveStatus, "failed");
  });

  it("marks expired active jobs stale and bad timestamps unknown", async () => {
    const dir = await setup();
    await put(dir, "stale", receipt("stale", { status: "running", updatedAt: "2026-11-20T11:00:00.000Z" }));
    await put(dir, "future", receipt("future", { updatedAt: "2026-11-20T12:02:00.000Z" }));
    await put(dir, "reverse", receipt("reverse", { startedAt: "2026-11-20T11:30:00.000Z", updatedAt: "2026-11-20T11:00:00.000Z" }));
    const { jobs } = await getSnapshot({ directory: dir, now: fixedNow });
    assert.deepEqual(jobs.map(j => j.effectiveStatus), ["unknown", "unknown", "stale"]);
  });

  it("reports malformed, mismatched, symlink, and oversized receipts as warnings", async () => {
    const dir = await setup();
    await writeFile(join(dir, "bad.json"), "{");
    await put(dir, "good", receipt("other"));
    await writeFile(join(dir, "large.json"), "x".repeat(32 * 1024 + 1));
    await symlink(join(root, "evidence.txt"), join(dir, "link.json"));
    const snapshot = await getSnapshot({ directory: dir, now: fixedNow });
    assert.equal(snapshot.jobs.length, 0);
    assert.equal(snapshot.warnings.length, 4);
  });

  it("keeps failed status and rejects symlink evidence and logs", async () => {
    const dir = await setup();
    await put(dir, "failed", receipt("failed", { status: "failed", evidence: { path: join(root, "link-evidence"), sha256: hash }, logPath: join(root, "link-log") }));
    await symlink(join(root, "evidence.txt"), join(root, "link-evidence"));
    await symlink(join(root, "evidence.txt"), join(root, "link-log"));
    const detail = await getDetail("failed", { directory: dir, now: fixedNow });
    assert.equal(detail.job.effectiveStatus, "failed");
    assert.equal(detail.evidenceText, null);
    assert.equal(detail.logTail, null);
    assert.ok(detail.warnings.length >= 1);
  });

  it("tails logs and does not mutate receipt or evidence files", async () => {
    const dir = await setup();
    const logPath = join(root, "long.log");
    const contents = "a".repeat(30 * 1024) + "TAIL";
    await writeFile(logPath, contents);
    await put(dir, "logged", receipt("logged", { status: "failed", logPath }));
    const receiptPath = join(dir, "logged.json");
    const beforeReceipt = await readFile(receiptPath);
    const beforeEvidence = await readFile(join(root, "evidence.txt"));
    const receiptMtime = (await lstat(receiptPath)).mtimeMs;
    const evidenceMtime = (await lstat(join(root, "evidence.txt"))).mtimeMs;
    const detail = await getDetail("logged", { directory: dir, now: fixedNow });
    assert.equal(detail.logTail?.length, 24 * 1024);
    assert.ok(detail.logTail?.endsWith("TAIL"));
    assert.deepEqual(await readFile(receiptPath), beforeReceipt);
    assert.deepEqual(await readFile(join(root, "evidence.txt")), beforeEvidence);
    assert.equal((await lstat(receiptPath)).mtimeMs, receiptMtime);
    assert.equal((await lstat(join(root, "evidence.txt"))).mtimeMs, evidenceMtime);
  });
});
