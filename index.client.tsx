import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { subscribeLocale } from "./client/i18n/locale";
import { startComposerPills } from "./client/ui/composer-pills";
import { SidebarMeter } from "./client/ui/sidebar-meter";
import { sidebarTitle } from "./client/ui/sidebar-title";
import { UsageSurface } from "./client/ui/usage-surface";

const SCREEN_ID = "usage";

function UsageRow({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Gauge"
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
    />
  );
}

/**
 * The host registrations that carry a *string* label rather than a component.
 *
 * Everything else in this plugin re-renders from the live locale, but these hand
 * Paseo a fixed string, so the only way to change the language they show is to
 * withdraw the registration and make it again.
 */
function registerLabels(client: PluginClientContext): PluginCleanup {
  const title = sidebarTitle();
  const removers = [
    // Two separate items so each can be moved or hidden on its own in
    // Settings → Sidebar: hide the row and the meter stays, and vice versa.
    client.addSidebarHeaderItem({ id: "usage", title, Component: UsageRow }),
    client.addSidebarHeaderItem({ id: "usage-meter", title: `${title} · meter`, Component: SidebarMeter }),
    client.addScreen({ id: SCREEN_ID, title, Component: UsageSurface }),
    // The same panel under Settings: set the pins up once, then the sidebar row can be hidden.
    client.addSettingsScreen({
      id: SCREEN_ID,
      title,
      icon: "Gauge",
      Component: UsageSurface,
    }),
    client.addCommandCenterItem({
      id: "open-usage",
      title,
      // Searchable in English regardless of the display language: the command
      // center is typed into, and muscle memory outlives a language switch.
      keywords: ["usage", "quota", "plan", "limit", "tokens"],
      icon: "Gauge",
      context: "global",
      onSelect: ({ openScreen }) => {
        openScreen({ screenId: SCREEN_ID });
      },
    }),
  ];
  return () => {
    for (const remove of removers) {
      remove();
    }
  };
}

/**
 * Client entry: the screen, its sidebar row, the usage meter, its settings
 * screen, the Command Center shortcut, and the composer pills for extra Claude accounts.
 */
export default function contribute(client: PluginClientContext): PluginCleanup {
  let removeLabels = registerLabels(client);

  // Only fires on an actual change of resolved locale, so the re-registration
  // costs nothing while the language is left alone.
  const stopWatchingLocale = subscribeLocale(() => {
    removeLabels();
    removeLabels = registerLabels(client);
  });

  const stopPills = startComposerPills(client);

  return () => {
    stopWatchingLocale();
    stopPills();
    removeLabels();
  };
}
