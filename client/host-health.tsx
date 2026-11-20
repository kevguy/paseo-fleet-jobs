import { Text, View } from "react-native";
import type { Snapshot } from "../shared/receipt";

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
export function HostHealth({ snapshot, uncertain, foreground, muted, border }: {
  snapshot: Snapshot; uncertain: boolean; foreground: string; muted: string; border: string;
}) {
  const resources = snapshot.resources;
  const monitor = snapshot.monitor;
  const fresh = resources && !uncertain && Date.now() - Date.parse(resources.observedAt) <= (resources.freshnessSeconds + 30) * 1000;
  const monitorFresh = monitor?.lastCollectedAt && !uncertain && Date.now() - Date.parse(monitor.lastCollectedAt) <= 180_000;
  return <View style={{ gap: 8 }}>
    {resources?.configured && <View style={{ borderWidth: 1, borderColor: border, borderRadius: 10, padding: 12, gap: 6 }}>
      <Text style={{ color: foreground, fontWeight: "600" }}>Resources{!fresh ? " · readings need refresh" : ""}</Text>
      {resources.configurationError && <Text style={{ color: muted }}>{resources.configurationError}</Text>}
      {resources.disks.map(disk => <Text key={disk.id} style={{ color: muted }}>{disk.label}: {fresh && disk.status === "available" && disk.availableBytes !== null ? `${gib(disk.availableBytes)} free · ${disk.usedPercent?.toFixed(0)}% used${disk.usedPercent !== null && disk.usedPercent >= 90 ? " · Low free space (10% or less available)" : ""}` : "unknown"}{disk.error ? ` · ${disk.error}` : ""}</Text>)}
      {resources.gpu.devices.map((gpu, i) => <Text key={i} style={{ color: muted }}>{gpu.name}: {fresh ? `${gpu.utilizationPercent}% busy · ${gib(gpu.memoryUsedBytes)} / ${gib(gpu.memoryTotalBytes)} VRAM` : "unknown"}</Text>)}
      {resources.gpu.error && <Text style={{ color: muted }}>{resources.gpu.error}</Text>}
      {(resources.gpu.devices.length > 0 || resources.gpu.error) && <Text style={{ color: muted }}>GPU reservation availability is unknown.</Text>}
      {resources.heavyClaims.status !== "unknown" && <Text style={{ color: muted }}>Work claims: {fresh && resources.heavyClaims.status === "available" ? `${resources.heavyClaims.unexpiredCount} unexpired (${resources.heavyClaims.unexpiredWeight} units), ${resources.heavyClaims.expiredCount} expired, ${resources.heavyClaims.unknownCount} unreadable` : "unknown"}. Claims do not prove that a process is alive or capacity is free.</Text>}
      {resources.heavyClaims.error && <Text style={{ color: muted }}>{resources.heavyClaims.error}</Text>}
      <Text style={{ color: muted, fontSize: 12 }}>Observed {new Date(resources.observedAt).toLocaleTimeString()}</Text>
    </View>}
    {monitor && <>
      <Text style={{ color: muted, fontSize: 12 }}>{monitorFresh ? "Background collector checked" : "Background collection needs a fresh check"}{monitor.lastCollectedAt ? ` · ${new Date(monitor.lastCollectedAt).toLocaleTimeString()}` : ""}</Text>
      {monitor.error && <Text accessibilityRole="alert" style={{ color: muted }}>{monitor.error}</Text>}
      {monitor.warnings.map((warning, i) => <Text key={i} style={{ color: muted }}>{warning}</Text>)}
      {monitor.alerts.length > 0 && <View style={{ gap: 5, padding: 12, borderWidth: 1, borderColor: border, borderRadius: 10 }}>
        <Text style={{ color: foreground, fontWeight: "600" }}>Recent changes{uncertain ? " · cached history" : ""}</Text>
        {monitor.alerts.slice(0, 5).map(alert => <Text key={alert.id} style={{ color: muted }}>{alert.title} · {alert.status} · {new Date(alert.observedAt).toLocaleString()}</Text>)}
        <Text style={{ color: muted, fontSize: 12 }}>Past observations, not current status. {monitor.alerts.length > 5 ? `${monitor.alerts.length - 5} older entries are retained in the local inbox. ` : ""}Changes appear here once per job, run and state.</Text>
      </View>}
    </>}
  </View>;
}
