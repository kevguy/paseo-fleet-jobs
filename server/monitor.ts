import { homedir } from "node:os";
import { join } from "node:path";
import { lstat, mkdir } from "node:fs/promises";
import { collectObservations } from "./observe";
import { getSnapshot } from "./store";
import { recordTransitions, withMonitorLock } from "./alerts";

export async function collectOnce(home = process.env.FLEET_JOBS_HOME || join(homedir(), ".paseo-fleet-jobs")) {
  const result = await withMonitorLock(home, async () => {
    const directory = join(home, "jobs");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Jobs store must be a real directory");
    const observed = await collectObservations(home);
    const snapshot = await getSnapshot({ directory: join(home, "jobs"), includeExtras: false });
    const warnings = [...observed.warnings, ...snapshot.warnings];
    const alerts = await recordTransitions(home, snapshot.jobs, warnings);
    return { busy: false, jobs: snapshot.jobs.length, newAlerts: alerts.length, warnings };
  });
  return result ?? { busy: true, jobs: 0, newAlerts: 0, warnings: ["Another collector owns monitor.lock; no state was changed."] };
}

export function startMonitor() {
  let stopped = false;
  let busy = false;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try { await collectOnce(); }
    catch { console.warn("Fleet Jobs: background collection failed; check the monitor freshness and configuration."); }
    finally { busy = false; }
  };
  void tick();
  const timer = setInterval(() => void tick(), 60_000);
  timer.unref?.();
  return () => { stopped = true; clearInterval(timer); };
}
