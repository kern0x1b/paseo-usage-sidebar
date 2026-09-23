/**
 * The short forms the sidebar meter prints in column mode.
 *
 * Run: npm test
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { messagesFor } from "../shared/i18n/messages";
import { formatRemainingCompact, windowTone, windowUsedPct } from "../shared/usage/format";
import { windowShortLabel } from "../shared/usage/window-label";

const window = (id: string, label = "") => ({ id, label });

describe("windowShortLabel", () => {
  it("codes the rolling windows and keeps the model name", () => {
    assert.equal(windowShortLabel(window("five_hour", "Session")), "5H");
    assert.equal(windowShortLabel(window("weekly", "Weekly")), "1W");
    assert.equal(windowShortLabel(window("weekly_model_fable", "Weekly · Fable")), "1W Fable");
    assert.equal(windowShortLabel(window("interval_x", "Interval X")), "Interval X");
  });
});

describe("formatRemainingCompact", () => {
  const messages = messagesFor("en");
  const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

  it("prints the bare time left in two units", () => {
    assert.equal(formatRemainingCompact(inMs((3 * 60 + 27) * 60_000 + 30_000), messages), "3h 27m");
    assert.equal(formatRemainingCompact(inMs((2 * 24 + 20) * 3_600_000 + 60_000), messages), "2d 20h");
  });

  it("is null for a past or missing instant", () => {
    assert.equal(formatRemainingCompact(inMs(-1000), messages), null);
    assert.equal(formatRemainingCompact(null, messages), null);
  });
});

describe("a window past its reset", () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();

  it("reads as empty and calm even while the cached number is still 100%", () => {
    const stale = { id: "five_hour", label: "Session", usedPct: 100, resetsAt: past, tone: "danger" as const };
    assert.equal(windowUsedPct(stale), 0);
    assert.equal(windowTone(stale), "ok");
  });

  it("keeps its number until then", () => {
    const live = { id: "five_hour", label: "Session", usedPct: 100, resetsAt: future, tone: "danger" as const };
    assert.equal(windowUsedPct(live), 100);
    assert.equal(windowTone(live), "danger");
  });
});
