import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getSnapshot } from "./server/store";
import { getFleet, getFleetDetail } from "./server/fleet";
import { snapshotRpc, detailRpc, fleetRpc } from "./shared/jobs";
import { startMonitor } from "./server/monitor";
export default function contribute(server: PluginServerContext) {
  server.handle(snapshotRpc, () => getSnapshot());
  server.handle(fleetRpc, () => getFleet());
  server.handle(detailRpc, ({ id, sourceId }) => getFleetDetail(sourceId, id));
  return startMonitor();
}
