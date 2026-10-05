/**
 * `readUsage` against a mocked host: a fake `paseo.providers.listUsage` plus a
 * mocked clock, so the escalation window is exercised without waiting for it.
 *
 * Run: npm test
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { HOST_LINK_LOST_CODE, SUSPECT_GRACE_MS } from "../shared/usage/errors";

type Reader = typeof import("../server/usage/read")["readUsage"];

/**
 * `readUsage` keeps the link-failure state in module scope (it has to outlive a
 * single poll), so each test needs its own instance of the module. A distinct
 * query string is a different specifier to the ESM loader, hence a fresh one.
 */
let instance = 0;
async function freshReader(): Promise<Reader> {
  instance += 1;
  const module = (await import(`../server/usage/read.ts?case=${instance}`)) as { readUsage: Reader };
  return module.readUsage;
}

/** Minimal stand-in for PluginHandlerContext: only listUsage is reached. */
function hostThatFails(error: Error) {
  const listUsage = mock.fn(async () => {
    throw error;
  });
  return { listUsage, context: { paseo: { providers: { listUsage } } } as never };
}

function hostThatReturns(payload: unknown) {
  const listUsage = mock.fn(async () => payload);
  return { listUsage, context: { paseo: { providers: { listUsage } } } as never };
}

const SNAPSHOT = {
  fetchedAt: "2025-01-01T00:00:00.000Z",
  providers: [{ providerId: "anthropic", displayName: "Claude", status: "available", planLabel: "Max 5x" }],
};

/** Silences the once-per-link-loss diagnostic without losing the assertion on it. */
let logged: string[] = [];
const realError = console.error;

beforeEach(() => {
  // Keeps the extra-Claude-account lookup away from the real ~/.paseo/config.json.
  process.env.PASEO_HOME = "/nonexistent/paseo-home";
  logged = [];
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
});

afterEach(() => {
  console.error = realError;
  delete process.env.PASEO_USAGE_SIDEBAR_FAULT;
  mock.reset();
});

describe("readUsage", () => {
  it("validates and normalizes a healthy payload", async () => {
    const readUsage = await freshReader();
    const host = hostThatReturns(SNAPSHOT);

    const snapshot = await readUsage({}, host.context);

    assert.equal(snapshot.source, "sdk");
    assert.equal(snapshot.providers.length, 1);
    assert.equal(snapshot.providers[0]?.planLabel, "Max 5x");
    // Fields the daemon omitted are defaulted, not left undefined.
    assert.deepEqual(snapshot.providers[0]?.windows, []);
  });

  it("tags a proven link loss with the code the client matches on", async () => {
    const readUsage = await freshReader();
    const host = hostThatFails(new Error("Update the host to list provider usage"));

    await assert.rejects(() => readUsage({}, host.context), new RegExp(HOST_LINK_LOST_CODE));
    assert.match(logged.join("\n"), /session with the Paseo daemon was dropped/);
  });

  it("logs the diagnosis once across repeated polls", async () => {
    const readUsage = await freshReader();
    const host = hostThatFails(new Error("Update the host to list provider usage"));

    await assert.rejects(() => readUsage({}, host.context));
    await assert.rejects(() => readUsage({}, host.context));
    await assert.rejects(() => readUsage({}, host.context));

    assert.equal(logged.filter((line) => line.includes("was dropped")).length, 1);
    assert.equal(host.listUsage.mock.callCount(), 3);
  });

  it("passes an ordinary failure through untouched", async () => {
    const readUsage = await freshReader();
    const host = hostThatFails(new Error("provider rejected the request: 429"));

    await assert.rejects(() => readUsage({}, host.context), /429/);
    assert.equal(logged.length, 0);
  });

  it("does not blame the session for a blip inside the grace window", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 0 });
    const readUsage = await freshReader();
    const host = hostThatFails(new Error("Connection lost"));

    await assert.rejects(() => readUsage({}, host.context), /^Error: Connection lost$/);
    t.mock.timers.setTime(SUSPECT_GRACE_MS - 1);
    await assert.rejects(() => readUsage({}, host.context), /^Error: Connection lost$/);
    assert.equal(logged.length, 0);
  });

  it("blames the session once the blip outlives the grace window", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 0 });
    const readUsage = await freshReader();
    const host = hostThatFails(new Error("Connection lost"));

    await assert.rejects(() => readUsage({}, host.context));
    t.mock.timers.setTime(SUSPECT_GRACE_MS);
    await assert.rejects(() => readUsage({}, host.context), new RegExp(HOST_LINK_LOST_CODE));
  });

  it("forgets a suspected run as soon as one poll succeeds", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 0 });
    const readUsage = await freshReader();
    const failing = hostThatFails(new Error("Connection lost"));
    const healthy = hostThatReturns(SNAPSHOT);

    await assert.rejects(() => readUsage({}, failing.context));
    t.mock.timers.setTime(10_000);
    await readUsage({}, healthy.context);

    // Long past the first failure, but the run was broken, so this is a blip again.
    t.mock.timers.setTime(60_000);
    await assert.rejects(() => readUsage({}, failing.context), /^Error: Connection lost$/);
  });
});

/**
 * A provider whose poll came back empty is the failure this file exists for: the
 * daemon reports it as a successful snapshot, so nothing upstream of the client
 * treats it as an error, and the provider simply disappears from the plugin.
 */
describe("readUsage keeps the last reading of a provider whose poll came back empty", () => {
  const CODEX_WINDOW = {
    id: "session",
    label: "Session",
    usedPct: 42,
    remainingPct: 58,
    resetsAt: "2026-10-05T15:00:00.000Z",
  };
  const CODEX = { providerId: "codex", displayName: "Codex", status: "available", windows: [CODEX_WINDOW] };
  /** What the daemon sends when Codex's usage API answers 429. */
  const CODEX_RATE_LIMITED = {
    providerId: "codex",
    displayName: "Codex",
    status: "error",
    error: "Codex usage API returned 429",
  };

  it("keeps the windows and marks them stale when the next poll is rate limited", async () => {
    const readUsage = await freshReader();

    const healthy = await readUsage({}, hostThatReturns({ providers: [CODEX] }).context);
    assert.deepEqual(healthy.providers[0]?.windows, [CODEX_WINDOW]);
    assert.equal(healthy.providers[0]?.stale, undefined);

    const limited = await readUsage({}, hostThatReturns({ providers: [CODEX_RATE_LIMITED] }).context);

    assert.deepEqual(limited.providers[0]?.windows, [CODEX_WINDOW]);
    assert.equal(limited.providers[0]?.stale, true);
    // The reason it stopped moving is the more useful half of the card.
    assert.equal(limited.providers[0]?.status, "error");
    assert.match(limited.providers[0]?.error ?? "", /429/);
  });

  it("clears the stale marker once the provider reports again", async () => {
    const readUsage = await freshReader();
    await readUsage({}, hostThatReturns({ providers: [CODEX] }).context);
    await readUsage({}, hostThatReturns({ providers: [CODEX_RATE_LIMITED] }).context);

    const recovered = await readUsage({}, hostThatReturns({ providers: [CODEX] }).context);

    assert.equal(recovered.providers[0]?.stale, undefined);
    assert.deepEqual(recovered.providers[0]?.windows, [CODEX_WINDOW]);
  });

  it("keeps the numbers when a provider answers 'available' with none in it", async () => {
    const readUsage = await freshReader();
    await readUsage({}, hostThatReturns({ providers: [CODEX] }).context);

    const empty = await readUsage(
      {},
      hostThatReturns({
        providers: [{ providerId: "codex", displayName: "Codex", status: "available", windows: [] }],
      }).context,
    );

    assert.deepEqual(empty.providers[0]?.windows, [CODEX_WINDOW]);
    assert.equal(empty.providers[0]?.stale, true);
  });

  it("leaves the other providers alone when one card cannot be read at all", async () => {
    const readUsage = await freshReader();
    const host = hostThatReturns({
      providers: [
        CODEX,
        { providerId: "antigravity-cli", displayName: "Antigravity", status: "available", windows: [{ id: "weekly", label: "Weekly", usedPct: 7 }] },
        // A window field this plugin does not model.
        { providerId: "future", displayName: "Future", status: "available", windows: [{ id: "w", label: "W", usedPct: "half" }] },
      ],
    });

    const snapshot = await readUsage({}, host.context);

    assert.deepEqual(
      snapshot.providers.map((provider) => provider.providerId),
      ["codex", "antigravity-cli"],
    );
    assert.match(logged.join("\n"), /dropping an unreadable usage card for "future"/);
  });

  it("says nothing about a card it never read a number for", async () => {
    const readUsage = await freshReader();

    const first = await readUsage({}, hostThatReturns({ providers: [CODEX_RATE_LIMITED] }).context);

    assert.deepEqual(first.providers[0]?.windows, []);
    assert.equal(first.providers[0]?.stale, undefined);
  });

  it("covers the plugin's own cards too, not only the daemon's", async () => {
    const readUsage = await freshReader();
    // `withRetainedReadings` runs over the merged list, so a card this plugin
    // fetched itself (an extra Claude account, Antigravity) is held to the same
    // rule as a daemon one — the ids are what it keys on, not where they came from.
    const ANTIGRAVITY = {
      providerId: "antigravity-cli",
      displayName: "Antigravity",
      status: "available",
      windows: [{ id: "five_hour_gemini", label: "Session · Gemini", usedPct: 100 }],
    };

    const healthy = await readUsage({}, hostThatReturns({ providers: [ANTIGRAVITY] }).context);
    const limited = await readUsage(
      {},
      hostThatReturns({
        providers: [
          {
            providerId: "antigravity-cli",
            displayName: "Antigravity",
            status: "error",
            error: "Antigravity quota API returned 429",
          },
        ],
      }).context,
    );

    assert.deepEqual(healthy.providers[0]?.windows, ANTIGRAVITY.windows);
    assert.deepEqual(limited.providers[0]?.windows, ANTIGRAVITY.windows);
    assert.equal(limited.providers[0]?.stale, true);
  });
});

describe("readUsage fault injection", () => {
  it("fails without reaching the host when PASEO_USAGE_SIDEBAR_FAULT=proven", async () => {
    process.env.PASEO_USAGE_SIDEBAR_FAULT = "proven";
    const readUsage = await freshReader();
    const host = hostThatReturns(SNAPSHOT);

    await assert.rejects(() => readUsage({}, host.context), new RegExp(HOST_LINK_LOST_CODE));
    assert.equal(host.listUsage.mock.callCount(), 0);
  });

  it("is ignored when set to an unknown value", async () => {
    process.env.PASEO_USAGE_SIDEBAR_FAULT = "nonsense";
    const readUsage = await freshReader();
    const host = hostThatReturns(SNAPSHOT);

    await readUsage({}, host.context);
    assert.equal(host.listUsage.mock.callCount(), 1);
    assert.match(logged.join("\n"), /expected proven\|suspected\|unrelated/);
  });
});
