import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { sourceSchema, snapshotSchema, detailSchema, type Source, type Fleet } from "../shared/receipt";
import { getSnapshot, getDetail } from "./store";

export function dataHome() { return process.env.FLEET_JOBS_HOME || join(homedir(), ".paseo-fleet-jobs"); }
export async function sources(): Promise<Source[]> {
  const path = join(dataHome(), "sources.json");
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 32768) throw new Error("sources.json must be a regular file under 32 KiB");
    const parsed = z.array(sourceSchema).max(8).parse(JSON.parse(await readFile(path, "utf8")));
    const ids = parsed.map(x => x.id);
    if (ids.includes("local") || new Set(ids).size !== ids.length) throw new Error("Source IDs must be unique and cannot be local");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("Cannot read sources.json: check its format, IDs and absolute CLI paths");
  }
}
// Only a fixed read-only subcommand is sent to SSH; no receipt data is executed.
export type SshRunner = (file: string, args: string[], options: { timeout: number; maxBuffer: number; windowsHide: boolean }) => Promise<string>;

const runSsh: SshRunner = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, options, (error, stdout) => error ? reject(error) : resolve(stdout));
});

export function remoteRead(source: Source, command: "snapshot" | "detail", id?: string, runner: SshRunner = runSsh): Promise<unknown> {
  const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
  const args = [source.cliPath, command, ...(id ? [id] : []), ...(source.dataHome ? ["--home", source.dataHome] : [])];
  const nodePath = source.nodePath ?? "node";
  const sshOptions = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=yes"];
  if (source.knownHostsFile) sshOptions.push("-o", `UserKnownHostsFile=${source.knownHostsFile}`);
  return runner("ssh", [...sshOptions, source.sshHost, `${quote(nodePath)} ${args.map(quote).join(" ")}`],
    { timeout: 12000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })
    .catch(() => { throw new Error("Host unavailable or reader not installed; check SSH and CLI path"); })
    .then(stdout => {
      try { return JSON.parse(stdout); } catch { throw new Error("Host returned invalid reader output"); }
    });
}
export type FleetDependencies = {
  loadLocalSnapshot?: typeof getSnapshot;
  loadSources?: typeof sources;
  readRemote?: typeof remoteRead;
  localHostLabel?: typeof hostname;
};
export async function getFleet(dependencies: FleetDependencies = {}): Promise<Fleet> {
  const loadLocalSnapshot = dependencies.loadLocalSnapshot ?? getSnapshot;
  const loadSources = dependencies.loadSources ?? sources;
  const readRemote = dependencies.readRemote ?? remoteRead;
  const localHostLabel = dependencies.localHostLabel ?? hostname;
  const hosts: Fleet["hosts"] = [];
  const warnings: string[] = [];
  try { hosts.push({ id: "local", label: localHostLabel(), snapshot: await loadLocalSnapshot(), error: null }); }
  catch { hosts.push({ id: "local", label: localHostLabel(), snapshot: null, error: "Cannot read this host's receipts" }); }
  let configured: Source[] = [];
  try { configured = await loadSources(); } catch (error) { warnings.push((error as Error).message); }
  // Bounded fanout: at most 8 fixed reader calls, each with an independent timeout.
  hosts.push(...await Promise.all(configured.map(async source => {
    const base = { id: source.id, label: source.label, serverId: source.serverId };
    try { return { ...base, snapshot: snapshotSchema.parse(await readRemote(source, "snapshot")), error: null }; }
    catch (error) { return { ...base, snapshot: null, error: (error as Error).message }; }
  })));
  return { hosts, warnings };
}
export async function getFleetDetail(sourceId: string, id: string) {
  if (sourceId === "local") return getDetail(id);
  const source = (await sources()).find(s => s.id === sourceId);
  if (!source) throw new Error("Unknown source; refresh the fleet");
  return detailSchema.parse(await remoteRead(source, "detail", id));
}
