/**
 * Keeping the last known numbers through a poll that brought none.
 *
 * Run: npm test
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProviderUsageSchema, type ProviderUsage } from "../shared/usage/contract";
import { hasReading, isDegraded, isStale, retainLastGood } from "../shared/usage/preserve";

function card(over: Partial<ProviderUsage> = {}): ProviderUsage {
  return ProviderUsageSchema.parse({
    providerId: "codex",
    displayName: "Codex",
    status: "available",
    ...over,
  });
}

const READING = {
  windows: [{ id: "session", label: "Session", usedPct: 42, remainingPct: 58 }],
  fetchedAt: "2026-10-05T10:00:00.000Z",
};

/** How the daemon answers when one provider's fetch was rate limited. */
const RATE_LIMITED = { status: "error", error: "Codex usage API returned 429" } as const;

describe("hasReading", () => {
  it("counts windows and balances, and nothing else", () => {
    assert.equal(hasReading(card(READING)), true);
    assert.equal(hasReading(card({ balances: [{ id: "c", label: "C", remaining: 5, unit: "usd" }] })), true);
    assert.equal(hasReading(card()), false);
    assert.equal(hasReading(card({ details: [{ id: "d", label: "D", value: "v" }] })), false);
  });
});

describe("isDegraded", () => {
  it("is true for a failed status and for a success that carried no numbers", () => {
    assert.equal(isDegraded(card(RATE_LIMITED)), true);
    assert.equal(isDegraded(card({ status: "unavailable" })), true);
    // The response shape changed: the provider still says it is fine.
    assert.equal(isDegraded(card()), true);
    assert.equal(isDegraded(card(READING)), false);
  });
});

describe("retainLastGood", () => {
  it("keeps the last numbers when a rate limit empties the card", () => {
    const merged = retainLastGood(card(RATE_LIMITED), card(READING));

    assert.deepEqual(merged.windows, READING.windows);
    assert.equal(isStale(merged), true);
  });

  it("keeps the failed poll's status and reason over the remembered card's", () => {
    const merged = retainLastGood(card(RATE_LIMITED), card({ ...READING, error: "an older failure" }));

    assert.equal(merged.status, "error");
    assert.equal(merged.error, "Codex usage API returned 429");
  });

  it("carries the age of the numbers it kept, not the age of the failure", () => {
    const merged = retainLastGood(card({ ...RATE_LIMITED, fetchedAt: "2026-10-05T10:05:00.000Z" }), card(READING));

    assert.equal(merged.fetchedAt, READING.fetchedAt);
  });

  it("keeps a plan label that the failed poll no longer sent", () => {
    const merged = retainLastGood(card(RATE_LIMITED), card({ ...READING, planLabel: "Plus" }));

    assert.equal(merged.planLabel, "Plus");
  });

  it("prefers a plan label the failed poll did send", () => {
    const merged = retainLastGood(card({ ...RATE_LIMITED, planLabel: "Pro" }), card({ ...READING, planLabel: "Plus" }));

    assert.equal(merged.planLabel, "Pro");
  });

  it("leaves a poll that brought numbers of its own alone", () => {
    const fresh = card({ ...READING, windows: [{ id: "session", label: "Session", usedPct: 61 }] });

    assert.equal(retainLastGood(fresh, card(READING)), fresh);
    assert.equal(isStale(retainLastGood(fresh, card(READING))), false);
  });

  it("has nothing to fall back on before the first good poll", () => {
    const first = card(RATE_LIMITED);

    assert.equal(retainLastGood(first, undefined), first);
    assert.equal(isStale(retainLastGood(first, undefined)), false);
  });

  it("does not claim numbers for an account that never read any", () => {
    const poll = card(RATE_LIMITED);
    const remembered = card({ status: "unavailable", error: "no credentials" });

    // Nothing to merge in, so the card stays as the poll left it: no numbers, and
    // no stale marker claiming there were some.
    assert.equal(retainLastGood(poll, remembered), poll);
    assert.equal(isStale(retainLastGood(poll, remembered)), false);
  });

  it("does not mutate either input", () => {
    const poll = card(RATE_LIMITED);
    const lastGood = card(READING);
    const snapshot = JSON.stringify([poll, lastGood]);

    retainLastGood(poll, lastGood);

    assert.equal(JSON.stringify([poll, lastGood]), snapshot);
  });
});

describe("isStale", () => {
  it("treats a card without the flag as fresh", () => {
    assert.equal(isStale(card(READING)), false);
    assert.equal(isStale({ ...card(READING), stale: undefined }), false);
    assert.equal(isStale(card({ ...READING, stale: true })), true);
  });
});
