import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { getSnapshot } from "../server/store";
import { collectObservations } from "../server/observe";
import { observerSchema, observersSchema } from "../shared/observer";

const archive = process.env.FLEET_JOBS_TEST_ROOT || path.resolve(".validation/observer-tests");
let sandbox = "";
let home = "";
let artifacts = "";

before(async () => {
  await mkdir(archive, { recursive: true });
  sandbox = await mkdtemp(path.join(archive, "run-"));
  home = path.join(sandbox, "home");
  artifacts = path.join(sandbox, "artifacts");
  await mkdir(home, { recursive: true });
  await mkdir(artifacts);
});

after(async () => { if (sandbox) await rm(sandbox, { recursive: true, force: true }); });

function startTime(): string { return new Date(Date.now() - 60_000).toISOString(); }

async function configure(entry: Record<string, unknown> | Record<string, unknown>[]) {
  const entries = Array.isArray(entry) ? entry : [entry];
  await writeFile(path.join(home, "observers.json"), JSON.stringify(entries));
}

function observer(id: string, evidencePath: string, extra: Record<string, unknown> = {}) {
  return {
    id, title: `Synthetic ${id}`, evidencePath, runStartedAt: startTime(),
    staleAfterSeconds: 900,
    outcome: { kind: "text", successMarker: "RESULT: PASS", failureMarker: "RESULT: FAIL" },
    ...extra,
  };
}

test("uses exact configured markers and hashes fresh explicit evidence", async () => {
  const resultPath = path.join(artifacts, "success.txt");
  const text = "Build output\nRESULT: PASS\n";
  await writeFile(resultPath, text);
  await configure(observer("observe-text-success", resultPath));

  const result = await collectObservations(home);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.receipts[0]?.status, "succeeded");
  assert.equal(result.receipts[0]?.evidence?.path, resultPath);
  assert.equal(result.receipts[0]?.evidence?.sha256, createHash("sha256").update(text).digest("hex"));
  assert.equal(result.receipts[0]?.updatedAt, new Date((await stat(resultPath)).mtimeMs).toISOString());
});

test("only an observed heartbeat reports running and its mtime supplies updatedAt", async () => {
  const resultPath = path.join(artifacts, "incomplete.txt");
  const heartbeatPath = path.join(artifacts, "heartbeat.txt");
  await writeFile(resultPath, "Still preparing output");
  await writeFile(heartbeatPath, "pulse");
  const heartbeatMtime = (await stat(heartbeatPath)).mtimeMs;
  await configure(observer("observe-heartbeat", resultPath, { heartbeatPath }));

  const result = await collectObservations(home);
  assert.equal(result.receipts[0]?.status, "running");
  assert.equal(Date.parse(result.receipts[0]!.updatedAt), Math.trunc(heartbeatMtime));

  await configure(observer("observe-no-heartbeat", resultPath));
  const noHeartbeat = await collectObservations(home);
  assert.equal(noHeartbeat.receipts[0]?.status, "waiting");
});

test("reads heartbeat and log mtimes without reading large or non-UTF-8 logs", async () => {
  const resultPath = path.join(artifacts, "large-log-result.txt");
  const logPath = path.join(artifacts, "large-log.bin");
  await writeFile(resultPath, "Still preparing output");
  await writeFile(logPath, Buffer.alloc(40 * 1024, 0xff));
  const logMtime = (await stat(logPath)).mtimeMs;
  await configure(observer("observe-large-log", resultPath, { logPath, heartbeatPath: logPath }));

  const result = await collectObservations(home);
  assert.equal(result.receipts[0]?.status, "running");
  assert.equal(Date.parse(result.receipts[0]!.updatedAt), Math.trunc(logMtime));
  assert.equal(result.warnings.length, 0);

  await configure(observer("observe-diagnostic-log", resultPath, { logPath }));
  const diagnostic = await collectObservations(home);
  assert.equal(diagnostic.receipts[0]?.status, "waiting");
});

test("valid terminal evidence wins when its heartbeat has disappeared", async () => {
  const resultPath = path.join(artifacts, "finished-result.txt");
  await writeFile(resultPath, "RESULT: FAIL\n");
  await configure(observer("observe-finished-without-heartbeat", resultPath, {
    heartbeatPath: path.join(artifacts, "heartbeat-that-is-gone"),
  }));

  const result = await collectObservations(home);
  assert.equal(result.receipts[0]?.status, "failed");
  assert.ok(result.receipts[0]?.evidence?.sha256);

  const symlinkHeartbeat = path.join(artifacts, "finished-heartbeat-link");
  await symlink(resultPath, symlinkHeartbeat);
  await configure(observer("observe-finished-with-invalid-heartbeat", resultPath, { heartbeatPath: symlinkHeartbeat }));
  const withInvalidHeartbeat = await collectObservations(home);
  assert.equal(withInvalidHeartbeat.receipts[0]?.status, "failed");
});

test("unassessed observers capture evidence and log time without reporting success", async () => {
  const resultPath = path.join(artifacts, "unassessed-result.json");
  const logPath = path.join(artifacts, "unassessed.log");
  const resultText = JSON.stringify({ score: 0.96, checks: 18 });
  await writeFile(resultPath, resultText);
  await writeFile(logPath, "completed scoring output\n");
  const logMtime = (await stat(logPath)).mtimeMs;
  await configure(observer("observe-unassessed", resultPath, { logPath, outcome: { kind: "unassessed" } }));

  const result = await collectObservations(home);
  const receipt = result.receipts[0]!;
  assert.equal(receipt.status, "unknown");
  assert.equal(receipt.evidence?.sha256, createHash("sha256").update(resultText).digest("hex"));
  assert.equal(Date.parse(receipt.updatedAt), Math.trunc(logMtime));
  assert.match(receipt.message ?? "", /No acceptance verdict is configured/);
});

test("does not regress terminal receipts when evidence changes", async () => {
  const resultPath = path.join(artifacts, "immutable-result.txt");
  await writeFile(resultPath, "RESULT: PASS\noriginal evidence");
  await configure(observer("observe-immutable", resultPath));
  const first = await collectObservations(home);
  assert.equal(first.receipts[0]?.status, "succeeded");
  const originalHash = first.receipts[0]!.evidence!.sha256;

  await writeFile(resultPath, "RESULT: FAIL\nchanged evidence");
  const second = await collectObservations(home);
  assert.equal(second.receipts[0]?.status, "succeeded");
  assert.equal(second.receipts[0]?.evidence?.sha256, originalHash);
  const snapshot = await getSnapshot({ directory: path.join(home, "jobs") });
  const job = snapshot.jobs.find((entry) => entry.id === "observe-immutable");
  assert.equal(job?.status, "succeeded");
  assert.equal(job?.effectiveStatus, "unknown");
  assert.equal(job?.evidenceVerified, false);
});

test("uses JSON scalar rules and refuses an existing manual receipt", async () => {
  const jsonPath = path.join(artifacts, "result.json");
  await writeFile(jsonPath, JSON.stringify({ result: { state: "done" } }));
  await configure(observer("observe-json", jsonPath, {
    outcome: { kind: "json", fieldPath: ["result", "state"], successValue: "done", failureValue: "error" },
  }));
  const json = await collectObservations(home);
  assert.equal(json.receipts[0]?.status, "succeeded");

  const manualId = "observe-manual-collision";
  const manualPath = path.join(home, "jobs", `${manualId}.json`);
  await mkdir(path.dirname(manualPath), { recursive: true });
  const startedAt = startTime();
  await writeFile(manualPath, JSON.stringify({ schemaVersion: 1, id: manualId, title: "Manual", status: "running", startedAt, updatedAt: startedAt }));
  await configure(observer(manualId, jsonPath));
  const collision = await collectObservations(home);
  assert.equal(collision.receipts.length, 0);
  assert.match(collision.warnings.join(" "), /without an observer ownership marker/);
  assert.equal(JSON.parse(await readFile(manualPath, "utf8")).title, "Manual");
});

test("rejects duplicate IDs and treats stale-run evidence as waiting", async () => {
  const resultPath = path.join(artifacts, "old.txt");
  await writeFile(resultPath, "RESULT: PASS");
  await configure([
    observer("observe-duplicate", resultPath),
    observer("observe-duplicate", resultPath),
  ]);
  let result = await collectObservations(home);
  assert.equal(result.receipts.length, 0);
  assert.match(result.warnings.join(" "), /duplicate IDs/);
  const repeated = [observer("duplicate", resultPath), observer("duplicate", resultPath)];
  assert.equal(observersSchema.safeParse(repeated).success, false);
  assert.equal(observerSchema.safeParse(observer("relative", "relative-result.txt")).success, false);

  const oldStart = new Date(Date.now() - 120_000);
  await utimes(resultPath, oldStart, oldStart);
  await configure(observer("observe-stale-evidence", resultPath, { runStartedAt: new Date(Date.now() - 30_000).toISOString() }));
  result = await collectObservations(home);
  assert.equal(result.receipts[0]?.status, "unknown");
  assert.equal(result.receipts[0]?.evidence, undefined);

  const invalidPath = path.join(artifacts, "invalid-utf8.bin");
  await writeFile(invalidPath, Buffer.from([0xc3, 0x28]));
  await configure(observer("observe-invalid-utf8", invalidPath));
  result = await collectObservations(home);
  assert.equal(result.receipts[0]?.status, "unknown");
  assert.equal(result.receipts[0]?.evidence, undefined);

  const symlinkPath = path.join(artifacts, "linked-result.txt");
  await symlink(resultPath, symlinkPath);
  await configure(observer("observe-symlink", symlinkPath));
  result = await collectObservations(home);
  assert.equal(result.receipts[0]?.status, "unknown");
  assert.equal(result.receipts[0]?.evidence, undefined);
});
