import type { PluginCleanup } from "@getpaseo/plugin";
import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import React, { type ComponentType } from "react";
import { getLocale, subscribeLocale } from "../i18n/locale";
import { formatPct, windowUsedPct } from "../../shared/usage/format";
import {
  listUsage,
  type ProviderUsage,
  type UsageSnapshot,
} from "../../shared/usage/contract";
import { readSelection, type Selection } from "../../shared/selection/contract";
import { getSelection, subscribeSelection } from "../selection/store";
import { AccountUsagePopover } from "./usage-surface";

/**
 * A pill in the composer of every agent that runs on an extra Claude account.
 *
 * Paseo's context-window tooltip shows plan limits by looking the agent's
 * provider id up in the daemon's usage list, and an extra account is not in that
 * list, so its agents only ever get the context ring. The pill puts the same two
 * numbers next to it; agents on the default account keep the host's tooltip and
 * get no pill.
 */
const REFRESH_INTERVAL_MS = 60_000;
const AGENT_PAGE_LIMIT = 200;
/** The two windows the label summarizes; the popover shows all of them. */
const LABEL_WINDOW_IDS = ["five_hour", "weekly"] as const;

type AgentPlacement = { workspaceId: string; provider: string };
type Pill = { providerId: string; registration: PluginButtonRegistration };

function pillLabel(provider: ProviderUsage | undefined): string {
  if (!provider || provider.status !== "available") {
    return "—";
  }
  const locale = getLocale("web");
  return LABEL_WINDOW_IDS.map((id) => {
    const window = provider.windows.find((candidate) => candidate.id === id);
    const usedPct = window ? windowUsedPct(window) : null;
    return usedPct === null ? "—" : formatPct(usedPct, locale);
  }).join(" · ");
}

function pillTitle(
  provider: ProviderUsage | undefined,
  providerId: string,
): string {
  if (!provider) {
    return providerId;
  }
  return provider.planLabel
    ? `${provider.displayName} · ${provider.planLabel}`
    : provider.displayName;
}

export function startComposerPills(client: PluginClientContext): PluginCleanup {
  const agents = new Map<string, AgentPlacement>();
  const pills = new Map<string, Pill>();
  const popovers = new Map<string, ComponentType<PluginButtonContentProps>>();
  let snapshot: UsageSnapshot | null = null;
  let stopped = false;
  /** The panel's "Show limits in the message box" checkbox; on until the saved selection says otherwise. */
  let enabled = getSelection()?.composerPill ?? true;

  /** One component per provider, so an update never swaps the popover's identity under an open pill. */
  function popoverFor(
    providerId: string,
  ): ComponentType<PluginButtonContentProps> {
    let Popover = popovers.get(providerId);
    if (!Popover) {
      Popover = ({ theme, layout }: PluginButtonContentProps) => (
        <AccountUsagePopover
          providerId={providerId}
          theme={theme}
          layout={layout}
        />
      );
      popovers.set(providerId, Popover);
    }
    return Popover;
  }

  function sync(): void {
    if (stopped) {
      return;
    }
    const accountIds = new Set(enabled ? (snapshot?.accountProviderIds ?? []) : []);
    for (const [agentId, pill] of pills) {
      const agent = agents.get(agentId);
      if (
        !agent ||
        agent.provider !== pill.providerId ||
        !accountIds.has(agent.provider)
      ) {
        pill.registration.remove();
        pills.delete(agentId);
      }
    }
    for (const [agentId, agent] of agents) {
      if (!accountIds.has(agent.provider)) {
        continue;
      }
      const provider = snapshot?.providers.find(
        (candidate) => candidate.providerId === agent.provider,
      );
      const label = pillLabel(provider);
      const title = pillTitle(provider, agent.provider);
      const existing = pills.get(agentId);
      if (existing) {
        existing.registration.update({ label, title });
        continue;
      }
      const registration = client.addComposerPill({
        id: `account-usage-${agentId}`,
        workspaceId: agent.workspaceId,
        agentId,
        button: {
          title,
          label,
          icon: "Gauge",
          behavior: { kind: "popover", Content: popoverFor(agent.provider) },
        },
      });
      pills.set(agentId, { providerId: agent.provider, registration });
    }
  }

  function track(agent: {
    id: string;
    provider: string;
    workspaceId?: string;
    archivedAt?: string | null;
  }): void {
    if (agent.workspaceId && !agent.archivedAt) {
      agents.set(agent.id, {
        workspaceId: agent.workspaceId,
        provider: agent.provider,
      });
    } else {
      agents.delete(agent.id);
    }
  }

  // Subscribed before the initial list so an agent created in between is not missed.
  const unsubscribeAgents = client.paseo.agents.subscribe((update) => {
    if (update.kind === "upsert") {
      track(update.agent);
    } else {
      agents.delete(update.agentId);
    }
    sync();
  });

  async function loadAgents(): Promise<void> {
    try {
      const result = await client.paseo.agents.list({
        scope: "active",
        page: { limit: AGENT_PAGE_LIMIT },
        subscribe: {},
      });
      for (const entry of result.entries) {
        track(entry.agent);
      }
      sync();
    } catch {
      // No pills until the next agent update arrives; the composer is unaffected.
    }
  }

  async function refresh(): Promise<void> {
    try {
      snapshot = (await client.rpc(listUsage, {})) as UsageSnapshot;
      sync();
    } catch {
      // Keeps the last numbers on the pills rather than blanking them on one failed poll.
    }
  }

  // The panel publishes every save here, so the checkbox takes effect at once.
  const unsubscribeSelection = subscribeSelection((selection: Selection) => {
    enabled = selection.composerPill;
    sync();
  });

  async function loadSelection(): Promise<void> {
    try {
      enabled = ((await client.rpc(readSelection, {})) as Selection).composerPill;
      sync();
    } catch {
      // Stays on, which is the default.
    }
  }

  void loadSelection();
  void loadAgents();
  void refresh();
  const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
  // The label's percent formatting follows the display language.
  const unsubscribeLocale = subscribeLocale(() => sync());

  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribeAgents();
    unsubscribeLocale();
    unsubscribeSelection();
    for (const pill of pills.values()) {
      pill.registration.remove();
    }
    pills.clear();
  };
}
