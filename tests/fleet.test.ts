import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { getFleet, remoteRead, sources, type SshRunner } from "../server/fleet";
import { sourceSchema, type Snapshot, type Source } from "../shared/receipt";

const archive = process.env.FLEET_JOBS_TEST_ROOT || resolve(".validation/fleet-tests");
let root = "";
let previousHome: string | undefined;

function source(overrides: Record<string, unknown> = {}): Source {
  return sourceSchema.parse({
    id: "build-host", label: "Build host", sshHost: "build@example.test",
    cliPath: "/opt/fleet jobs/bin/fleet-jobs.mjs", dataHome: "/var/lib/fleet jobs", ...overrides,
  });
}

function snapshot(host = "test-host"): Snapshot {
  return { host, observedAt: "2026-11-20T12:00:00.000Z", receiptDirectory: "/synthetic/receipts", jobs: [], warnings: [], truncated: false };
}

before(async () => {
  await mkdir(archive, { recursive: true });
  root = await mkdtemp(join(archive, "case-"));
  previousHome = process.env.FLEET_JOBS_HOME;
  process.env.FLEET_JOBS_HOME = root;
});

after(() => {
  if (previousHome === undefined) delete process.env.FLEET_JOBS_HOME;
  else process.env.FLEET_JOBS_HOME = previousHome;
});

describe("fleet source configuration", () => {
  it("accepts bounded source records and rejects invalid paths and extra fields", () => {
    assert.equal(sourceSchema.safeParse({ id: "host-2", label: "Host 2", sshHost: "host.example", cliPath: "/usr/local/bin/fleet-jobs.mjs", nodePath: "/opt/homebrew/bin/node", knownHostsFile: "/Users/test/.ssh/fleet_known_hosts" }).success, true);
    assert.equal(sourceSchema.safeParse({ id: "host-2", label: "Host 2", sshHost: "host.example", cliPath: "fleet-jobs" }).success, false);
    assert.equal(sourceSchema.safeParse({ id: "host-2", label: "Host 2", sshHost: "host.example", cliPath: "/usr/bin/fleet", nodePath: "node; arbitrary-command" }).success, false);
    assert.equal(sourceSchema.safeParse({ id: "host-2", label: "Host 2", sshHost: "host.example", cliPath: "/usr/bin/fleet", command: "arbitrary" }).success, false);
  });

  it("rejects duplicate or reserved IDs in sources.json", async () => {
    const duplicate = [source(), source({ label: "Second label" })];
    await writeFile(join(root, "sources.json"), JSON.stringify(duplicate));
    await assert.rejects(sources(), /Cannot read sources\.json/);

    await writeFile(join(root, "sources.json"), JSON.stringify([source({ id: "local" })]));
    await assert.rejects(sources(), /Cannot read sources\.json/);
  });

  it("returns no configured hosts when the optional config is absent", async () => {
    const fresh = await mkdtemp(join(archive, "empty-config-"));
    process.env.FLEET_JOBS_HOME = fresh;
    assert.deepEqual(await sources(), []);
    process.env.FLEET_JOBS_HOME = root;
  });
});

describe("fixed read-only SSH reader", () => {
  it("uses SSH batch mode and a fixed reader subcommand with safely quoted arguments", async () => {
    const configured = source({ nodePath: "/opt/node tools/node", knownHostsFile: "/Users/test/.ssh/fleet_hosts" });
    let actual: { file: string; args: string[]; options: { timeout: number; maxBuffer: number; windowsHide: boolean } } | undefined;
    const runner: SshRunner = async (file, args, options) => {
      actual = { file, args, options };
      return JSON.stringify(snapshot("remote"));
    };
    const hostileId = "x'; injected payload; echo '";
    const result = await remoteRead(configured, "detail", hostileId, runner);
    assert.deepEqual(result, snapshot("remote"));
    assert.equal(actual?.file, "ssh");
    assert.deepEqual(actual?.args.slice(0, 10), ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=/Users/test/.ssh/fleet_hosts", "build@example.test"]);
    assert.equal(actual?.args[10], "'/opt/node tools/node' '/opt/fleet jobs/bin/fleet-jobs.mjs' 'detail' 'x'\\''; injected payload; echo '\\''' '--home' '/var/lib/fleet jobs'");
    assert.deepEqual(actual?.options, { timeout: 12000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  });

  it("uses the default node command and translates timeout/offline errors to a stable message", async () => {
    let remoteCommand = "";
    const success: SshRunner = async (_file, args) => { remoteCommand = args.at(-1) ?? ""; return "not-json"; };
    await assert.rejects(remoteRead(source(), "snapshot", undefined, success), /Host returned invalid reader output/);
    assert.equal(remoteCommand, "'node' '/opt/fleet jobs/bin/fleet-jobs.mjs' 'snapshot' '--home' '/var/lib/fleet jobs'");

    const offline: SshRunner = async () => { const error = new Error("timed out"); Object.assign(error, { code: "ETIMEDOUT" }); throw error; };
    await assert.rejects(remoteRead(source(), "snapshot", undefined, offline), /Host unavailable or reader not installed/);
  });

  it("keeps successful hosts when another host is offline or times out", async () => {
    const online = source({ id: "online", label: "Online" });
    const offline = source({ id: "offline", label: "Offline", sshHost: "offline@example.test" });
    const fleet = await getFleet({
      localHostLabel: () => "local-test",
      loadLocalSnapshot: async () => snapshot("local"),
      loadSources: async () => [online, offline],
      readRemote: async host => {
        if (host.id === "offline") throw new Error("Host unavailable after timeout");
        return snapshot("online");
      },
    });
    assert.deepEqual(fleet.hosts.map(host => host.id), ["local", "online", "offline"]);
    assert.equal(fleet.hosts.find(host => host.id === "online")?.snapshot?.host, "online");
    assert.equal(fleet.hosts.find(host => host.id === "offline")?.snapshot, null);
    assert.match(fleet.hosts.find(host => host.id === "offline")?.error ?? "", /timeout/);
  });
});
