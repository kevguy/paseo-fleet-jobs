import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { recordTransitions, readMonitor, withMonitorLock } from "../server/alerts";
import { collectOnce } from "../server/monitor";
import type { Job } from "../shared/receipt";

const base = resolve(process.env.FLEET_JOBS_TEST_ROOT || ".validation/alert-tests");
async function home() { await mkdir(base, { recursive: true }); return mkdtemp(join(base, "case-")); }
function job(state: Job["effectiveStatus"], overrides: Partial<Job> = {}): Job {
  return { schemaVersion: 1, id: "training-one", title: "Training one", status: "running", effectiveStatus: state,
    startedAt: "2026-11-20T00:00:00.000Z", updatedAt: "2026-11-20T00:00:00.000Z", staleAfterSeconds: 60,
    reason: `Observed ${state}`, evidenceVerified: false, ...overrides };
}

test("baseline suppresses historical alerts; transitions persist and deduplicate across reads", async () => {
  const dir = await home();
  assert.deepEqual(await recordTransitions(dir, [job("failed")], []), []);
  assert.equal((await recordTransitions(dir, [job("unknown")], [])).length, 1);
  assert.equal((await readMonitor(dir)).alerts[0]?.status, "unknown");
  assert.equal((await recordTransitions(dir, [job("unknown")], [])).length, 0);
  await recordTransitions(dir, [job("running")], []);
  assert.equal((await recordTransitions(dir, [job("unknown")], [])).length, 0);
  assert.equal((await readMonitor(dir)).alerts.length, 1);
  assert.equal((await recordTransitions(dir, [job("failed", { startedAt: "2026-11-20T01:00:00.000Z" })], [])).length, 1);
});

test("a concurrent collector cannot modify state; lock is released after failure", async () => {
  const dir = await home();
  await assert.rejects(withMonitorLock(dir, async () => {
    assert.equal(await withMonitorLock(dir, async () => "unexpected"), null);
    throw new Error("intentional");
  }), /intentional/);
  assert.equal(await withMonitorLock(dir, async () => "released"), "released");
});

test("corrupt state stays intact and is surfaced, not silently reset into duplicate alerts", async () => {
  const dir = await home();
  await writeFile(join(dir, "monitor.json"), "broken");
  assert.ok((await readMonitor(dir)).error);
  await assert.rejects(recordTransitions(dir, [job("failed")], []));
  assert.equal(await readFile(join(dir, "monitor.json"), "utf8"), "broken");
});

test("collection observes explicit evidence and publishes one outcome transition", async () => {
  const dir = await home();
  const evidence = join(dir, "gate.txt");
  const heartbeat = join(dir, "heartbeat.txt");
  await writeFile(heartbeat, "working");
  await writeFile(join(dir, "observers.json"), JSON.stringify([{ id: "observed-run", title: "Observed run", evidencePath: evidence,
    heartbeatPath: heartbeat, runStartedAt: new Date(Date.now() - 10_000).toISOString(), outcome: { kind: "text", successMarker: "GATE PASS", failureMarker: "GATE FAIL" } }]));
  assert.equal((await collectOnce(dir)).newAlerts, 0);
  await writeFile(evidence, "GATE FAIL");
  assert.equal((await collectOnce(dir)).newAlerts, 1);
  assert.equal((await readMonitor(dir)).alerts[0]?.status, "failed");
  assert.equal((await collectOnce(dir)).newAlerts, 0);
  assert.equal((await readMonitor(dir)).alerts.length, 1);
});
