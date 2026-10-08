import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { messagesFor, type Locale, type Messages } from "../../shared/i18n/messages";
import { getLocale, subscribeLocale } from "../i18n/locale";
import { getSelection, publishSelection, subscribeSelection } from "../selection/store";
import { pinnedRows, readSelection, writeSelection, type Selection } from "../../shared/selection/contract";
import {
  clampPct,
  formatPct,
  formatRemainingCompact,
  formatResetPrimary,
  formatRunsOutLabel,
  windowTone,
} from "../../shared/usage/format";
import { paletteForSurface, type Palette } from "../../shared/usage/palette";
import { isMeterStale } from "../../shared/usage/errors";
import { listUsage, type UsageSnapshot, type UsageTone, type UsageWindow } from "../../shared/usage/contract";
import { windowLabel, windowShortLabel } from "../../shared/usage/window-label";

const REFRESH_INTERVAL_MS = 60_000;
const DEFAULT_SELECTION: Selection = {
  keys: [],
  configured: false,
  columns: 1,
  composerPill: true,
  collapsedProviders: [],
};

type MeterRow = { label: string; usedPct: number | null; tone: UsageTone; window: UsageWindow };
type MeterGroup = { providerId: string; provider: string; rows: MeterRow[]; stale: boolean };

function isAtRisk(window: UsageWindow): boolean {
  return window.runsOutAt != null && window.shortfallPct != null;
}

function familyOf(window: UsageWindow, messages: Messages): string | null {
  const id = window.id.toLowerCase();
  if (id.includes("gemini")) {
    return "Gemini";
  }
  if (id.includes("3p") || id.includes("other") || id.includes("claude_and_gpt")) {
    return messages.familyOtherModels;
  }
  const separator = window.label.indexOf("·");
  if (separator >= 0) {
    const suffix = window.label.slice(separator + 1).trim();
    if (/gemini/i.test(suffix)) {
      return "Gemini";
    }
    if (/other/i.test(suffix) || /3p/i.test(suffix)) {
      return messages.familyOtherModels;
    }
  }
  return null;
}

/**
 * Group pinned rows by provider, keeping the order Paseo reports. A provider
 * whose latest poll brought no numbers keeps the rows its last good poll
 * reported, and the group is marked stale.
 */
function toGroups(snapshot: UsageSnapshot, selection: Selection, messages: Messages): MeterGroup[] {
  const staleProviderIds = new Set(
    snapshot.providers.filter((provider) => provider.stale === true).map((provider) => provider.providerId),
  );
  const groups: MeterGroup[] = [];
  const rows = pinnedRows(snapshot, selection, (_provider, window) => windowLabel(window, messages), messages);
  for (const row of rows) {
    const entry: MeterRow = {
      label: row.label,
      usedPct: row.usedPct,
      tone: windowTone(row.window),
      window: row.window,
    };
    const last = groups[groups.length - 1];
    if (last && last.providerId === row.providerId) {
      last.rows.push(entry);
    } else {
      groups.push({
        providerId: row.providerId,
        provider: row.providerName,
        rows: [entry],
        stale: staleProviderIds.has(row.providerId),
      });
    }
  }
  return groups;
}

function familyRowLabel(row: MeterRow, family: string | null, messages: Messages): string {
  if (!family) {
    return row.label;
  }
  const id = row.window.id;
  if (id.startsWith("five_hour")) {
    return messages.windowFiveHour;
  }
  if (id.startsWith("weekly")) {
    return messages.windowWeekly;
  }
  if (id.startsWith("daily")) {
    return messages.windowDaily;
  }
  if (id.startsWith("monthly")) {
    return messages.windowMonthly;
  }
  return row.label;
}

function chunk<T>(items: T[], size: number): T[][] {
  const lines: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    lines.push(items.slice(index, index + size));
  }
  return lines;
}

function useLocale(): Locale {
  const [locale, setLocale] = useState<Locale>(() => getLocale("web"));
  useEffect(() => subscribeLocale(setLocale), []);
  return locale;
}

function useSelection(): Selection {
  const fetchSelection = useRpc(readSelection);
  const [selection, setSelection] = useState<Selection>(() => getSelection() ?? DEFAULT_SELECTION);
  useEffect(() => {
    const unsubscribe = subscribeSelection(setSelection);
    if (!getSelection()) {
      fetchSelection({})
        .then((loaded) => publishSelection(loaded as Selection))
        .catch(() => {
          // Leaves the default pin set in place.
        });
    }
    return unsubscribe;
  }, [fetchSelection]);
  return selection;
}

function useUsageSnapshot(): { snapshot: UsageSnapshot | null; consecutiveFailures: number } {
  const fetchUsage = useRpc(listUsage);
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = (await fetchUsage({})) as UsageSnapshot;
        if (!cancelled) {
          setSnapshot(next);
          setConsecutiveFailures(0);
        }
      } catch {
        // Keep the last snapshot; the countdowns keep ticking through a failed poll.
        if (!cancelled) {
          setConsecutiveFailures((count) => count + 1);
        }
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [fetchUsage]);
  return { snapshot, consecutiveFailures };
}

type MeterColors = { label: string; track: string; palette: Palette };

function Bar({ row, colors }: { row: MeterRow; colors: MeterColors }) {
  return (
    <View style={[styles.track, { backgroundColor: colors.track }]}>
      <View
        style={[
          styles.fill,
          { width: `${clampPct(row.usedPct ?? 0)}%`, backgroundColor: colors.palette[row.tone] },
        ]}
      />
    </View>
  );
}

function FullRow({
  row,
  family,
  colors,
  messages,
  locale,
}: {
  row: MeterRow;
  family: string | null;
  colors: MeterColors;
  messages: Messages;
  locale: Locale;
}) {
  const atRisk = isAtRisk(row.window);
  const timing = atRisk
    ? formatRunsOutLabel(row.window.runsOutAt, messages)
    : formatResetPrimary(row.window.resetsAt, locale, messages);
  return (
    <View style={styles.cell}>
      <View style={styles.head}>
        <Text numberOfLines={1} style={[styles.text, styles.grow, { color: colors.label }]}>
          {familyRowLabel(row, family, messages)}
        </Text>
        <Text style={[styles.text, styles.value, { color: colors.label }]}>
          {row.usedPct != null ? formatPct(row.usedPct, locale) : "—"}
        </Text>
      </View>
      <Bar row={row} colors={colors} />
      {timing ? (
        <Text
          numberOfLines={1}
          style={[styles.text, { color: atRisk ? colors.palette.danger : colors.label, opacity: atRisk ? 1 : 0.85 }]}
        >
          {timing}
        </Text>
      ) : null}
    </View>
  );
}

/** A column cell: `5H 25%` and the time left on one line, the bar under it. */
function CompactCell({
  row,
  colors,
  messages,
  locale,
}: {
  row: MeterRow;
  colors: MeterColors;
  messages: Messages;
  locale: Locale;
}) {
  const atRisk = isAtRisk(row.window);
  const remaining = formatRemainingCompact(atRisk ? row.window.runsOutAt : row.window.resetsAt, messages);
  return (
    <View style={styles.cell}>
      <View style={styles.head}>
        <Text numberOfLines={1} style={[styles.text, { color: colors.label }]}>
          <Text style={styles.dim}>{`${windowShortLabel(row.window)} `}</Text>
          <Text style={styles.value}>{row.usedPct != null ? formatPct(row.usedPct, locale) : "—"}</Text>
        </Text>
        {remaining ? (
          <Text
            numberOfLines={1}
            style={[styles.text, { color: atRisk ? colors.palette.danger : colors.label, opacity: atRisk ? 1 : 0.85 }]}
          >
            {remaining}
          </Text>
        ) : null}
      </View>
      <Bar row={row} colors={colors} />
    </View>
  );
}

function ProviderSection({
  group,
  selection,
  colors,
  messages,
  locale,
  onToggle,
}: {
  group: MeterGroup;
  selection: Selection;
  colors: MeterColors;
  messages: Messages;
  locale: Locale;
  onToggle: (providerId: string, collapsed: boolean) => void;
}) {
  const collapsed = Boolean(selection.collapsedProviders?.includes(group.providerId));
  const providerText = group.stale ? `${group.provider} · ${messages.stale}` : group.provider;

  const families = useMemo(() => {
    const result: { family: string | null; rows: MeterRow[] }[] = [];
    for (const row of group.rows) {
      const family = familyOf(row.window, messages);
      const last = result[result.length - 1];
      if (last && last.family === family) {
        last.rows.push(row);
      } else {
        result.push({ family, rows: [row] });
      }
    }
    return result;
  }, [group.rows, messages]);

  return (
    <View style={styles.section}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${collapsed ? messages.expand : messages.collapse} ${providerText}`}
        onPress={() => onToggle(group.providerId, !collapsed)}
        style={styles.providerHeader}
      >
        <Text numberOfLines={1} style={[styles.provider, styles.grow, { color: colors.label }]}>
          {providerText}
        </Text>
        <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} size={11} color={colors.label} />
      </Pressable>
      {collapsed
        ? null
        : families.map((entry, index) => (
            <View key={`${entry.family ?? "all"}-${index}`} style={styles.familyBlock}>
              {entry.family ? (
                <Text style={[styles.family, { color: colors.label }]}>{entry.family}</Text>
              ) : null}
              {chunk(entry.rows, Math.min(selection.columns, entry.rows.length)).map((line) => (
                <View key={line[0]?.window.id} style={styles.line}>
                  {line.map((row) =>
                    selection.columns > 1 ? (
                      <CompactCell key={row.window.id} row={row} colors={colors} messages={messages} locale={locale} />
                    ) : (
                      <FullRow
                        key={row.window.id}
                        row={row}
                        family={entry.family}
                        colors={colors}
                        messages={messages}
                        locale={locale}
                      />
                    ),
                  )}
                </View>
              ))}
            </View>
          ))}
    </View>
  );
}

/**
 * The always-visible usage block, a regular sidebar item: Paseo owns its slot,
 * order and visibility (Settings → Sidebar), and the plugin only supplies the rows.
 */
export function SidebarMeter({ theme }: PluginSidebarItemProps) {
  const locale = useLocale();
  const messages = useMemo(() => messagesFor(locale), [locale]);
  const selection = useSelection();
  const { snapshot, consecutiveFailures } = useUsageSnapshot();
  const persistSelection = useRpc(writeSelection);

  const groups = useMemo(
    () => (snapshot ? toGroups(snapshot, selection, messages) : []),
    [snapshot, selection, messages],
  );

  const colors = useMemo<MeterColors>(
    () => ({
      label: theme.colors.foregroundMuted,
      track: theme.colors.border,
      palette: paletteForSurface(theme.colors.surface0),
    }),
    [theme],
  );

  const toggleProvider = useCallback(
    (providerId: string, collapsed: boolean) => {
      const current = selection.collapsedProviders ?? [];
      const next = collapsed
        ? [...new Set([...current, providerId])]
        : current.filter((id) => id !== providerId);
      publishSelection({ ...selection, collapsedProviders: next });
      persistSelection({ collapsedProviders: next })
        .then((saved) => publishSelection(saved as Selection))
        .catch((error) => console.error("[usage-sidebar] Failed to save collapsed state:", error));
    },
    [selection, persistSelection],
  );

  if (groups.length === 0) {
    return null;
  }

  return (
    <View
      accessibilityLabel={messages.title}
      style={[styles.meter, { opacity: isMeterStale(consecutiveFailures, groups.length) ? 0.45 : 1 }]}
    >
      {groups.map((group) => (
        <ProviderSection
          key={group.providerId}
          group={group}
          selection={selection}
          colors={colors}
          messages={messages}
          locale={locale}
          onToggle={toggleProvider}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  meter: { paddingHorizontal: 12, paddingTop: 4, paddingBottom: 10, gap: 9 },
  section: { gap: 6 },
  providerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 6,
    paddingVertical: 2,
    opacity: 0.8,
  },
  provider: { fontSize: 10, fontWeight: "600", letterSpacing: 0.4 },
  familyBlock: { gap: 8 },
  family: { fontSize: 9, fontWeight: "600", letterSpacing: 0.4, opacity: 0.65, marginTop: 2 },
  line: { flexDirection: "row", gap: 12 },
  cell: { gap: 3, flex: 1, minWidth: 0 },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 6 },
  text: { fontSize: 11 },
  value: { fontWeight: "500" },
  dim: { opacity: 0.85 },
  grow: { flexShrink: 1, flexGrow: 1 },
  track: { height: 3, borderRadius: 2, overflow: "hidden" },
  fill: { height: 3, borderRadius: 2 },
});
