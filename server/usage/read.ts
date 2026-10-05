import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  ProviderUsageSchema,
  UsageSnapshotSchema,
  type ProviderUsage,
  type UsageSnapshot,
} from "../../shared/usage/contract";
import { listAntigravityUsage } from "./antigravity";
import { listClaudeAccountUsage, withClaudeAccounts } from "./claude-accounts";
import {
  errorMessage,
  HOST_LINK_LOST_CODE,
  INITIAL_LINK_FAILURE_STATE,
  judgeLinkFailure,
  type LinkFailureState,
} from "../../shared/usage/errors";
import { hasReading, retainLastGood } from "../../shared/usage/preserve";

/**
 * Paseo 0.8 exposes provider usage through the plugin SDK, and the manifest
 * requires `>=0.8.0`, so `paseo.providers.listUsage()` is always there.
 *
 * Until 0.8 this file also carried a fallback that opened its own WebSocket to
 * the daemon and replayed the `provider.usage.list` handshake by hand, because
 * 0.7 gave plugins no usage API. That path is unreachable under the new
 * requirement, and it was the only reason server code depended on the DOM's
 * `WebSocket`/`MessageEvent`/`CloseEvent` globals, so it is gone along with the
 * `PASEO_USAGE_SIDEBAR_HOST` override and the config.json endpoint probing.
 */

/**
 * The daemon's payload is validated rather than trusted, one provider at a time:
 * a provider that reports a window shape this plugin does not model should
 * degrade to a missing field, not take the other providers' cards down with it.
 * A card that cannot be parsed at all is dropped rather than guessed at.
 */
function normalize(payload: unknown): UsageSnapshot {
  const raw = (payload ?? {}) as { fetchedAt?: unknown; providers?: unknown };
  const providers: ProviderUsage[] = [];
  for (const entry of Array.isArray(raw.providers) ? raw.providers : []) {
    const parsed = ProviderUsageSchema.safeParse(entry);
    if (parsed.success) {
      providers.push(parsed.data);
      continue;
    }
    const providerId =
      typeof (entry as { providerId?: unknown } | null)?.providerId === "string"
        ? (entry as { providerId: string }).providerId
        : "(unnamed)";
    reportDropped(providerId, parsed.error);
  }
  return UsageSnapshotSchema.parse({
    fetchedAt: typeof raw.fetchedAt === "string" ? raw.fetchedAt : null,
    source: "sdk",
    providers,
  });
}

/** Provider ids whose card was dropped, so the warning is one line per provider. */
const droppedProviders = new Set<string>();

function reportDropped(providerId: string, error: unknown): void {
  if (droppedProviders.has(providerId)) {
    return;
  }
  droppedProviders.add(providerId);
  console.error(
    `usage-sidebar: dropping an unreadable usage card for "${providerId}" (${errorMessage(error)}). ` +
      "Every other provider is still shown.",
  );
}

/**
 * The last card that carried numbers, per provider. Kept per plugin process for
 * the same reason the link-failure state is: a poll has to be able to see what
 * the poll before it saw.
 */
const lastReadings = new Map<string, ProviderUsage>();

/**
 * Puts the last known numbers back under a poll that brought none.
 *
 * A rate limit, a timeout or a token the CLI has not refreshed yet arrives as a
 * *successful* snapshot in which one provider has `windows: []` and a status of
 * `error`/`unavailable`, because the daemon answers each provider's failure that
 * way and caches it. Taken at face value that empties the card and drops the
 * provider's rows out of the sidebar meter, and nothing marks the difference
 * between "used no quota" and "could not be read". Remembering the last reading
 * turns the same poll into the numbers plus a stale marker.
 */
function withRetainedReadings(providers: ProviderUsage[]): ProviderUsage[] {
  for (const provider of providers) {
    // Remembered from the poll, not from the merge below: what is worth keeping
    // is a card that read numbers, and a card rebuilt from a remembered one is
    // not a fresh reading of anything.
    if (hasReading(provider)) {
      lastReadings.set(provider.providerId, provider);
    }
  }
  return providers.map((provider) =>
    retainLastGood(provider, lastReadings.get(provider.providerId)),
  );
}

/**
 * Failure history, kept per plugin process rather than per call: the grace
 * window in `judgeLinkFailure` only means anything if a poll can see what the
 * poll before it saw.
 */
let linkFailure: LinkFailureState = INITIAL_LINK_FAILURE_STATE;

/**
 * Errors the fault switch can stand in for, spelled the way the host spells
 * them so the classifier is exercised on real input rather than on a sentinel
 * only the tests know about.
 */
const FAULTS = {
  proven: "Update the host to list provider usage",
  suspected: "Connection lost",
  unrelated: "provider rejected the request: 429",
} as const;

/** One warning per process, not one per poll, for a switch left set by mistake. */
let faultWarned = false;

/**
 * `PASEO_USAGE_SIDEBAR_FAULT` forces a failure without a daemon to break.
 * Dropping a real session means suspending the machine and waiting for the
 * lease to expire, which is not something a reviewer should have to stage to
 * see what this path renders.
 *
 * An unrecognized value is reported and ignored rather than treated as a fault:
 * the switch is a development aid, and failing shut would turn a typo in
 * someone's shell profile into a plugin that never loads usage again.
 */
function injectedFault(): Error | null {
  const name = process.env.PASEO_USAGE_SIDEBAR_FAULT;
  if (!name) {
    return null;
  }
  if (Object.hasOwn(FAULTS, name)) {
    return new Error(FAULTS[name as keyof typeof FAULTS]);
  }
  if (!faultWarned) {
    faultWarned = true;
    console.error(
      `usage-sidebar: ignoring PASEO_USAGE_SIDEBAR_FAULT="${name}" (expected proven|suspected|unrelated)`,
    );
  }
  return null;
}

export async function readUsage(
  _input: Record<string, never>,
  context: PluginHandlerContext,
): Promise<UsageSnapshot> {
  // Started before the daemon call so both run in parallel. It never rejects, so
  // nothing it does can be mistaken for the daemon link failing below.
  const claudeAccounts = listClaudeAccountUsage();
  const antigravity = listAntigravityUsage();
  try {
    const fault = injectedFault();
    if (fault) {
      throw fault;
    }
    const snapshot = normalize(await context.paseo.providers.listUsage());
    // A reading got through, so whatever the last failures were, they were not
    // this session ending.
    linkFailure = INITIAL_LINK_FAILURE_STATE;
    const daemonProviderIds = new Set(snapshot.providers.map((provider) => provider.providerId));
    const providers = withRetainedReadings([
      ...withClaudeAccounts(snapshot.providers, await claudeAccounts),
      // A card of the daemon's own for Antigravity, should it ever report one, wins.
      ...(await antigravity).filter((provider) => !daemonProviderIds.has(provider.providerId)),
    ]);
    return {
      ...snapshot,
      providers,
      accountProviderIds: providers
        .map((provider) => provider.providerId)
        .filter((providerId) => !daemonProviderIds.has(providerId)),
    };
  } catch (error) {
    const verdict = judgeLinkFailure(error, Date.now(), linkFailure);
    linkFailure = verdict.state;

    if (verdict.kind === "rethrow") {
      // Unchanged, so the panel keeps showing the host's own wording and keeps
      // offering the retry that might still work.
      throw error;
    }
    if (verdict.announce) {
      console.error(
        `usage-sidebar: the session with the Paseo daemon was dropped (${errorMessage(error)}). ` +
          "Reload the plugin to reconnect.",
      );
    }
    // The code travels in the message because that is all the host's handler-error
    // wrapper preserves on the way to the client.
    throw new Error(`${HOST_LINK_LOST_CODE}: ${errorMessage(error)}`);
  }
}
