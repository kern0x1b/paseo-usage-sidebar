import type { ProviderUsage } from "./contract";

/**
 * Keeping the last reading across a poll that produced none.
 *
 * A usage poll that fails is not reported as a failure. The daemon answers
 * `provider.usage.list` from a per-provider cache: a 429, a timeout or a token
 * the CLI has not refreshed yet turns into `status: "error"` (or
 * `"unavailable"`) with `windows: []`, and that *succeeds* — so the client sees
 * a fresh, valid snapshot in which the provider simply has nothing left to
 * show. Treated as authoritative, one rate-limited poll empties that provider's
 * card and drops its rows out of the sidebar meter, and the plugin's own
 * stale-value machinery never engages, because that only reacts to a failed
 * query (`shared/usage/errors.ts`).
 *
 * The daemon keeps no previous reading of its own, so it cannot be asked for
 * one. This module holds the last card that did carry numbers and merges it back
 * over the next poll's, flagged `stale`. The status and the error of the failed
 * poll are kept: the numbers on screen are the last known ones, and why they
 * stopped moving is the more useful half of that.
 */

/** A card with a number on it — the precondition for being worth remembering. */
export function hasReading(provider: ProviderUsage): boolean {
  return provider.windows.length > 0 || provider.balances.length > 0;
}

/**
 * A poll that produced no numbers of its own: it failed outright, or it reported
 * success while sending none. The second case is not hypothetical — a provider
 * whose response shape changes keeps answering `available` with nothing in it,
 * which is exactly as invisible as a rate limit.
 */
export function isDegraded(provider: ProviderUsage): boolean {
  return provider.status !== "available" || !hasReading(provider);
}

/**
 * Merges the last known reading under a poll that brought none.
 *
 * Returns the poll untouched when it has numbers of its own, when there is no
 * earlier reading, or when the earlier reading had no numbers either (an account
 * whose credentials were never readable has nothing to fall back to, and showing
 * it as stale would claim numbers that never existed).
 */
export function retainLastGood(
  poll: ProviderUsage,
  lastGood: ProviderUsage | undefined,
): ProviderUsage {
  if (!lastGood || !isDegraded(poll) || !hasReading(lastGood)) {
    return poll;
  }
  return {
    ...lastGood,
    // The failed poll's own verdict wins over the remembered card's: it is what
    // is happening now, and it is what explains the frozen numbers underneath.
    status: poll.status,
    error: poll.error ?? lastGood.error ?? null,
    // A remembered plan label beats none, but never over one just read.
    planLabel: poll.planLabel ?? lastGood.planLabel ?? null,
    // Age travels with the numbers it describes.
    fetchedAt: lastGood.fetchedAt ?? poll.fetchedAt,
    stale: true,
  };
}

/**
 * Whether a card is showing numbers from an earlier poll.
 *
 * `undefined` counts as fresh, so a card the daemon sent without the flag is
 * never mistaken for a stale one.
 */
export function isStale(provider: ProviderUsage): boolean {
  return provider.stale === true;
}
