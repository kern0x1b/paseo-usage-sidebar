/**
 * How a rearrangement of the rows on screen lands in the pin list that is saved.
 *
 * Run: npm test
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pinnedRows, reorderVisible, type Selection } from "../shared/selection/contract";
import { messagesFor } from "../shared/i18n/messages";
import type { ProviderUsage, UsageSnapshot, UsageWindow } from "../shared/usage/contract";
import { windowLabel } from "../shared/usage/window-label";

describe("reorderVisible", () => {
  const cases: Array<{ name: string; order: string[]; visible: string[]; expected: string[] }> = [
    {
      name: "is a plain reorder when every pin is on screen",
      order: ["a:1", "a:2", "b:1"],
      visible: ["b:1", "a:1", "a:2"],
      expected: ["b:1", "a:1", "a:2"],
    },
    {
      name: "keeps a pin the snapshot could not resolve, in its slot",
      order: ["a:1", "gone:1", "a:2", "b:1"],
      visible: ["b:1", "a:2", "a:1"],
      expected: ["b:1", "gone:1", "a:2", "a:1"],
    },
    {
      name: "keeps unresolved pins at either end",
      order: ["gone:1", "a:1", "a:2", "gone:2"],
      visible: ["a:2", "a:1"],
      expected: ["gone:1", "a:2", "a:1", "gone:2"],
    },
    {
      name: "leaves the list alone when nothing is on screen",
      order: ["gone:1", "gone:2"],
      visible: [],
      expected: ["gone:1", "gone:2"],
    },
    {
      name: "appends a visible key the list did not hold rather than dropping it",
      order: ["a:1"],
      visible: ["a:1", "stray:1"],
      expected: ["a:1", "stray:1"],
    },
  ];

  for (const { name, order, visible, expected } of cases) {
    it(name, () => {
      assert.deepEqual(reorderVisible(order, visible), expected);
    });
  }

  it("does not mutate its inputs", () => {
    const order = ["a:1", "a:2"];
    const visible = ["a:2", "a:1"];
    reorderVisible(order, visible);
    assert.deepEqual(order, ["a:1", "a:2"]);
    assert.deepEqual(visible, ["a:2", "a:1"]);
  });
});

/**
 * The scenario the helper exists for, end to end: a provider errors for one
 * poll, the user reorders what is left, and the provider comes back.
 */
describe("a reorder while one provider is missing", () => {
  const messages = messagesFor("en");
  const label = (_provider: ProviderUsage, window: { label: string }) => window.label;

  function provider(providerId: string, windowIds: string[]): ProviderUsage {
    return {
      providerId,
      displayName: providerId,
      status: windowIds.length > 0 ? "available" : "error",
      planLabel: null,
      windows: windowIds.map((id) => ({ id, label: id })),
      balances: [],
      details: [],
    };
  }

  function snapshot(providers: ProviderUsage[]): UsageSnapshot {
    return { fetchedAt: null, source: "sdk", providers };
  }

  it("still shows the missing provider's pin once it reports again", () => {
    const saved: Selection = { keys: ["claude:five_hour", "codex:weekly", "claude:weekly"], configured: true };

    const degraded = snapshot([provider("claude", ["five_hour", "weekly"]), provider("codex", [])]);
    const onScreen = pinnedRows(degraded, saved, label, messages).map((row) => row.key);
    assert.deepEqual(onScreen, ["claude:five_hour", "claude:weekly"]);

    const next = reorderVisible(saved.keys, [...onScreen].reverse());
    assert.deepEqual(next, ["claude:weekly", "codex:weekly", "claude:five_hour"]);

    const recovered = snapshot([provider("claude", ["five_hour", "weekly"]), provider("codex", ["weekly"])]);
    assert.deepEqual(
      pinnedRows(recovered, { keys: next, configured: true }, label, messages).map((row) => row.key),
      next,
    );
  });
});

/**
 * The live payload as captured on 2026-10-05 from this machine, with the pin
 * list this machine had saved the day before. Two providers did not reach the
 * meter and neither cause was in the row resolution: Codex's row resolves and
 * is merely hidden by the saved collapsed state, and Antigravity's four pins
 * have no window behind them because its OAuth token had expired and the card
 * came back `unavailable` with none.
 */
describe("the live 2026-10-05 payload", () => {
  const messages = messagesFor("en");
  const label = (_provider: ProviderUsage, window: UsageWindow) => windowLabel(window, messages);

  /** Straight from Paseo's CodexQuotaProvider for a `go` plan: one 30-day primary window. */
  const CODEX: ProviderUsage = {
    providerId: "codex",
    displayName: "Codex",
    status: "available",
    planLabel: "go",
    windows: [
      {
        id: "session",
        label: "Session",
        usedPct: 1,
        remainingPct: 99,
        resetsAt: "2026-11-04T14:42:27.000Z",
        tone: "ok",
      },
    ],
    balances: [],
    details: [],
    error: null,
  };

  const CLAUDE: ProviderUsage = {
    providerId: "claude",
    displayName: "Claude",
    status: "available",
    planLabel: "Max",
    windows: [
      { id: "five_hour", label: "Session", usedPct: 12, remainingPct: 88 },
      { id: "weekly", label: "Weekly", usedPct: 40, remainingPct: 60 },
    ],
    balances: [],
    details: [],
  };

  /** What the plugin's Antigravity fetcher really answered: 401, no windows. */
  const ANTIGRAVITY: ProviderUsage = {
    providerId: "antigravity-cli",
    displayName: "Antigravity",
    status: "unavailable",
    planLabel: null,
    windows: [],
    balances: [],
    details: [],
  };

  const SAVED: Selection = {
    keys: [
      "claude:five_hour",
      "claude:weekly",
      "antigravity-cli:five_hour_gemini",
      "antigravity-cli:weekly_gemini",
      "codex:session",
    ],
    configured: true,
    columns: 2,
    composerPill: true,
  };

  const snapshot: UsageSnapshot = {
    fetchedAt: "2026-10-05T15:05:00.000Z",
    source: "sdk",
    providers: [CLAUDE, CODEX, ANTIGRAVITY],
  };

  it("resolves Codex's single window, so its row is there to be collapsed", () => {
    const codex = pinnedRows(snapshot, SAVED, label, messages).find((row) => row.providerId === "codex");

    assert.equal(codex?.key, "codex:session");
    assert.equal(codex?.usedPct, 1);
    // Not coded as a 5-hour window: the plan's primary window is 30 days long.
    assert.equal(codex?.label, "Session");
  });

  it("drops exactly the Antigravity pins, and no others", () => {
    const resolved = pinnedRows(snapshot, SAVED, label, messages).map((row) => row.key);

    assert.deepEqual(resolved, ["claude:five_hour", "claude:weekly", "codex:session"]);
    for (const key of SAVED.keys) {
      assert.equal(
        resolved.includes(key) || key.startsWith("antigravity-cli:"),
        true,
        `${key} should still resolve`,
      );
    }
  });

  it("restores the Antigravity pins as soon as its card has windows again", () => {
    const recovered: UsageSnapshot = {
      ...snapshot,
      providers: [
        CLAUDE,
        CODEX,
        {
          ...ANTIGRAVITY,
          status: "available",
          windows: [
            { id: "five_hour_gemini", label: "Session · Gemini", usedPct: 30, remainingPct: 70 },
            { id: "weekly_gemini", label: "Weekly · Gemini", usedPct: 44, remainingPct: 56 },
          ],
        },
      ],
    };

    assert.deepEqual(
      pinnedRows(recovered, SAVED, label, messages).map((row) => row.key),
      ["claude:five_hour", "claude:weekly", "antigravity-cli:five_hour_gemini", "antigravity-cli:weekly_gemini", "codex:session"],
    );
  });
});
