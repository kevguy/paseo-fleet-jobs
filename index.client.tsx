import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { FleetScreen } from "./client/fleet";
function FleetItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="Activity" active={currentScreen?.screenId === "fleet-jobs"} onPress={() => openScreen({ screenId: "fleet-jobs" })} />;
}
export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "fleet-jobs", title: "Fleet Jobs", Component: FleetScreen });
  client.addSidebarHeaderItem({ id: "fleet-jobs", title: "Fleet Jobs", Component: FleetItem });
  return () => {};
}
