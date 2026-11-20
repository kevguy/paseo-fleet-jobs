import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { onlineManager, useQuery } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import { AppState, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { detailRpc, fleetRpc, type Fleet, type Job } from "../shared/jobs";

type Host = Fleet["hosts"][number];
const labels: Record<Job["effectiveStatus"], string> = { running: "Running", waiting: "Waiting", succeeded: "Succeeded", failed: "Failed", stale: "Stale", unknown: "Unknown" };
const attention = new Set(["failed", "stale", "unknown"]);

export function FleetScreen(props: PluginScreenProps) {
  const { theme, layout, host, navigation } = props;
  const c = theme.colors;
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<{ source: Host; id: string } | null>(null);
  const [active, setActive] = useState(AppState.currentState !== "background");
  useEffect(() => { const sub = AppState.addEventListener("change", s => setActive(s === "active")); return () => sub.remove(); }, []);
  useEffect(() => { setSelected(null); }, [host.id]);
  const online = useSyncExternalStore(callback => onlineManager.subscribe(callback), () => onlineManager.isOnline(), () => true);
  const [disconnectedAt, setDisconnectedAt] = useState(0);
  // A reopened screen must verify again, even if the shared query cache survived an outage.
  const [viewId] = useState(() => `${Date.now()}-${Math.random()}`);
  useEffect(() => { if (!online) setDisconnectedAt(Date.now()); }, [online]);
  const fetchFleet = useRpc(fleetRpc);
  const fetchDetail = useRpc(detailRpc);
  const fleet = useQuery({ queryKey: ["fleet-jobs", host.id, viewId], queryFn: async () => { const requestStartedAt = Date.now(); const connectedAtStart = onlineManager.isOnline(); return { ...await fetchFleet({}), requestStartedAt, connectedAtStart }; }, refetchInterval: active ? 30000 : false, refetchIntervalInBackground: false, retry: false });
  const detail = useQuery({ queryKey: ["fleet-job-detail", host.id, viewId, selected?.source.id, selected?.id], queryFn: async () => { const requestStartedAt = Date.now(); const connectedAtStart = onlineManager.isOnline(); return { ...await fetchDetail({ id: selected!.id, sourceId: selected!.source.id }), requestStartedAt, connectedAtStart }; }, enabled: !!selected, retry: false, refetchInterval: active && selected ? 30000 : false });
  const fleetUncertain = !online || fleet.isPaused || fleet.isError || (!!fleet.data && (!fleet.data.connectedAtStart || fleet.data.requestStartedAt <= disconnectedAt));
  const detailUncertain = !online || detail.isPaused || detail.isError || (!!detail.data && (!detail.data.connectedAtStart || detail.data.requestStartedAt <= disconnectedAt));
  const text = { color: c.foreground };
  const muted = { color: c.foregroundMuted };
  const button = { minHeight: 44, paddingHorizontal: 14, paddingVertical: 12, borderWidth: 1, borderColor: c.border, borderRadius: 10 };
  const rows = (fleet.data?.hosts ?? []).flatMap(source => (source.snapshot?.jobs ?? []).map(job => ({ source, job })));
  const effectiveState = (job: Job): Job["effectiveStatus"] => fleetUncertain ? "unknown" : job.effectiveStatus;
  const pending = rows.filter(x => attention.has(effectiveState(x.job))).length;
  const color = (state: Job["effectiveStatus"]) => state === "succeeded" ? "#23986a" : state === "failed" ? "#d55a64" : state === "running" ? c.accent : "#b48322";
  const selectedJob = detail.data?.job;
  return <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 28, paddingBottom: 48, gap: 18 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
      <View style={{ flexShrink: 1 }}>
        <Text style={{ ...muted, fontSize: 12, letterSpacing: 1.5 }}>FLEET JOBS</Text>
        <Text accessibilityRole="header" style={{ ...text, fontSize: layout.compact ? 26 : 32, fontWeight: "700", marginTop: 6 }}>{selected ? "Job evidence" : "Know where work stands."}</Text>
        <Text style={{ ...muted, marginTop: 8 }}>{selected ? selected.source.label : `${rows.length} jobs · ${pending} need attention · ${fleet.data?.hosts.length ?? 1} hosts`}</Text>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel={selected ? "Back to fleet" : "Refresh fleet"} style={button} onPress={() => selected ? setSelected(null) : void fleet.refetch()}><Text style={text}>{selected ? "← All jobs" : fleet.isFetching ? "Refreshing…" : "Refresh"}</Text></Pressable>
    </View>
    {fleetUncertain && <Text accessibilityRole="alert" style={{ color: "#d55a64" }}>Live status unavailable. Any displayed jobs are cached and their current state is unknown. Check the host connection and refresh.</Text>}
    {!selected && <>
      <Text style={muted}>{fleet.dataUpdatedAt ? `Last checked ${new Date(fleet.dataUpdatedAt).toLocaleTimeString()} · refreshes every 30 seconds while open` : "Connecting to the host…"}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {["all", "attention", "running", "waiting", "succeeded"].map(value => <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: filter === value }} onPress={() => setFilter(value)} style={{ ...button, backgroundColor: filter === value ? c.surface2 : c.surface0 }}><Text style={text}>{value === "all" ? "All jobs" : value === "attention" ? "Needs attention" : value[0]!.toUpperCase() + value.slice(1)}</Text></Pressable>)}
      </View>
      <TextInput accessibilityLabel="Search jobs" placeholder="Search job, project or owner" placeholderTextColor={c.foregroundMuted} value={search} onChangeText={setSearch} style={{ ...button, ...text, minHeight: 48 }} />
      {fleet.isPending && <Text style={muted}>Reading job receipts…</Text>}
      {fleet.data?.warnings.map((w, i) => <Text key={i} accessibilityRole="alert" style={muted}>{w}</Text>)}
      {fleet.data?.hosts.map(source => {
        const jobs = (source.snapshot?.jobs ?? []).filter(job => (filter === "all" || (filter === "attention" ? attention.has(effectiveState(job)) : effectiveState(job) === filter)) && `${job.title} ${job.project ?? ""} ${job.owner ?? ""} ${job.id}`.toLowerCase().includes(search.toLowerCase()));
        return <View key={source.id} style={{ gap: 10 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}><Text accessibilityRole="header" style={{ ...text, fontWeight: "600", fontSize: 18 }}>{source.label}</Text><Text style={muted}>{source.error ? "Unavailable" : `${source.snapshot?.jobs.length ?? 0} jobs`}</Text></View>
          {source.error && <Text accessibilityRole="alert" style={{ color: "#d55a64" }}>{source.error}. This host's job state is unknown.</Text>}
          {source.snapshot?.warnings.map((w, i) => <Text key={i} style={muted}>{w}</Text>)}
          {source.snapshot?.truncated && <Text style={muted}>Showing a bounded snapshot; additional receipts were omitted.</Text>}
          {jobs.map(job => <Pressable key={job.id} accessibilityRole="button" accessibilityLabel={`${job.title}, ${fleetUncertain ? "Unknown, cached" : labels[job.effectiveStatus]}. Open evidence`} onPress={() => setSelected({ source, id: job.id })} style={{ padding: 18, gap: 8, borderWidth: 1, borderColor: c.border, borderRadius: 14, backgroundColor: c.surface1 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}><Text style={{ ...text, fontWeight: "600", fontSize: 17, flexShrink: 1 }}>{job.title}</Text><Text style={{ color: color(fleetUncertain ? "unknown" : job.effectiveStatus), fontWeight: "600" }}>{fleetUncertain ? "Unknown · cached" : labels[job.effectiveStatus]}</Text></View>
            <Text style={muted}>{[job.project, job.owner, job.resource].filter(Boolean).join(" · ") || job.id}</Text>
            {job.message && <Text style={text} numberOfLines={3}>{job.message}</Text>}
            <Text style={muted}>{job.reason}</Text>
            {job.progress !== undefined && <View><View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: job.progress }} style={{ height: 4, backgroundColor: c.surface2, borderRadius: 2 }}><View style={{ width: `${job.progress}%`, height: 4, backgroundColor: c.accent, borderRadius: 2 }} /></View><Text style={{ ...muted, marginTop: 5 }}>{job.progress}% reported</Text></View>}
            <Text style={{ ...muted, fontSize: 12 }}>Updated {new Date(job.updatedAt).toLocaleString()} · View evidence →</Text>
          </Pressable>)}
          {source.snapshot && !jobs.length && <View style={{ padding: 18, borderColor: c.border, borderWidth: 1, borderRadius: 14, gap: 8 }}><Text style={text}>{source.snapshot.jobs.length ? "No jobs match these filters." : "No jobs registered yet."}</Text>{!source.snapshot.jobs.length && <><Text style={muted}>Have the job's script publish a receipt with the included fleet-jobs command. No jobs are discovered or started automatically.</Text><Text selectable style={muted}>{source.snapshot.receiptDirectory}</Text></>}</View>}
        </View>;
      })}
      <Text style={{ ...muted, fontSize: 12 }}>Read-only view · Outcomes are reported by your scripts; a verified checksum ties them to the saved evidence. Use this host's Screen sidebar item when you need remote control.</Text>
    </>}
    {selected && <>
      {detail.isPending && <Text style={muted}>Verifying the saved evidence…</Text>}
      {detailUncertain && <Text accessibilityRole="alert" style={{ color: "#d55a64" }}>Cannot refresh this job. Its current state is unknown. Return to the fleet and refresh.</Text>}
      {selectedJob && <View style={{ gap: 14 }}>
        <Text style={{ ...text, fontSize: 22, fontWeight: "600" }}>{selectedJob.title}</Text>
        <Text style={{ color: color(detailUncertain ? "unknown" : selectedJob.effectiveStatus) }}>{detailUncertain ? "Unknown · cached" : labels[selectedJob.effectiveStatus]} · {selectedJob.reason}</Text>
        <Text selectable style={muted}>Job {selectedJob.id}{selectedJob.owner ? ` · ${selectedJob.owner}` : ""}{selectedJob.waitingFor ? `\nWaiting for: ${selectedJob.waitingFor}` : ""}</Text>
        {selectedJob.message && <Text style={text}>{selectedJob.message}</Text>}
        {navigation && selectedJob.agentId && (selected.source.id === "local" || selected.source.serverId) && <Pressable accessibilityRole="button" style={button} onPress={() => navigation.openAgent({ agentId: selectedJob.agentId!, serverId: selected.source.id === "local" ? host.id : selected.source.serverId })}><Text style={text}>Open owning agent</Text></Pressable>}
        {detail.data?.warnings.map((w, i) => <Text key={i} style={muted}>{w}</Text>)}
        <Text accessibilityRole="header" style={{ ...text, fontSize: 18, fontWeight: "600" }}>Result evidence</Text>
        <Text selectable style={muted}>{selectedJob.evidence?.path ?? "No evidence registered"}</Text>
        {selectedJob.evidence && <Text selectable style={{ ...muted, fontSize: 12 }}>{selectedJob.evidenceVerified && !detailUncertain ? "Verified SHA-256" : "Unverified SHA-256"}: {selectedJob.evidence.sha256}</Text>}
        <Text selectable style={{ ...text, fontFamily: "monospace", fontSize: 12, backgroundColor: c.surface1, padding: 14, borderRadius: 10 }}>{detail.data?.evidenceText ?? "No readable evidence preview."}</Text>
        <Text accessibilityRole="header" style={{ ...text, fontSize: 18, fontWeight: "600" }}>Recent log</Text>
        <Text selectable style={{ ...text, fontFamily: "monospace", fontSize: 12, backgroundColor: c.surface1, padding: 14, borderRadius: 10 }}>{detail.data?.logTail ?? "No readable log registered."}</Text>
      </View>}
    </>}
  </ScrollView>;
}
