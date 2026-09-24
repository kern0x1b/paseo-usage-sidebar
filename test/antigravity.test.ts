/**
 * The Antigravity card, against a temp config, a fake Keychain and a fake quota API.
 *
 * Run: npm test
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { messagesFor } from "../shared/i18n/messages";
import { windowLabel, windowShortLabel } from "../shared/usage/window-label";

type Module = typeof import("../server/usage/antigravity");

/** The module caches its card, so each test gets its own instance. */
let instance = 0;
async function freshModule(): Promise<Module> {
  instance += 1;
  return (await import(`../server/usage/antigravity.ts?case=${instance}`)) as Module;
}

function configWith(plugins: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "usage-sidebar-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ plugins }));
  return path;
}

const ENABLED = { "antigravity-cli": { source: "directory", path: "/x", enabled: true } };

const KEYRING_ITEM = `go-keyring-base64:${Buffer.from(
  JSON.stringify({ token: { access_token: "token-agy", token_type: "Bearer" } }),
).toString("base64")}`;

/** Trimmed from a real `retrieveUserQuotaSummary` answer. */
const QUOTA_SUMMARY = {
  groups: [
    {
      displayName: "Gemini Models",
      buckets: [
        { bucketId: "gemini-weekly", window: "weekly", resetTime: "2026-10-01T14:22:48Z", remainingFraction: 0.8324266 },
        { bucketId: "gemini-5h", window: "5h", resetTime: "2026-09-24T19:22:48Z", remainingFraction: 0 },
      ],
    },
    {
      displayName: "Claude and GPT models",
      buckets: [
        { bucketId: "3p-weekly", window: "weekly", resetTime: "2026-10-01T17:51:55Z", remainingFraction: 0.6657841 },
        { bucketId: "3p-5h", window: "5h", resetTime: "2026-09-24T22:51:55Z" },
      ],
    },
  ],
};

function deps(
  configPath: string,
  options: { status?: number; body?: unknown; keychain?: string | null; platform?: NodeJS.Platform } = {},
) {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  return {
    requests,
    value: {
      configPath,
      platform: options.platform ?? ("darwin" as const),
      now: () => 0,
      runSecurity: async () => (options.keychain === undefined ? KEYRING_ITEM : options.keychain),
      fetch: (async (url: string, init: { headers: Record<string, string> }) => {
        requests.push({ url, headers: init.headers });
        return new Response(JSON.stringify(options.body ?? QUOTA_SUMMARY), { status: options.status ?? 200 });
      }) as unknown as typeof fetch,
    },
  };
}

describe("listAntigravityUsage", () => {
  it("builds a 5-hour and a weekly window per model group", async () => {
    const { listAntigravityUsage } = await freshModule();
    const fake = deps(configWith(ENABLED));
    const [card] = await listAntigravityUsage(fake.value);

    assert.equal(card?.providerId, "antigravity-cli");
    assert.equal(card?.status, "available");
    assert.deepEqual(
      card?.windows.map((window) => [window.id, window.label, window.usedPct]),
      [
        ["five_hour_gemini", "Session · Gemini", 100],
        ["weekly_gemini", "Weekly · Gemini", (1 - 0.8324266) * 100],
        ["five_hour_3p", "Session · Other models", null],
        ["weekly_3p", "Weekly · Other models", (1 - 0.6657841) * 100],
      ],
    );
    assert.equal(card?.windows[0]?.tone, "danger");
    assert.equal(card?.windows[0]?.resetsAt, "2026-09-24T19:22:48Z");
    assert.equal(fake.requests[0]?.headers.Authorization, "Bearer token-agy");
    assert.match(fake.requests[0]?.headers["User-Agent"] ?? "", /antigravity/);
  });

  it("shows nothing when the plugin is not enabled or this is not a Mac", async () => {
    const { listAntigravityUsage } = await freshModule();
    assert.deepEqual(await listAntigravityUsage(deps(configWith({})).value), []);
    assert.deepEqual(
      await listAntigravityUsage(
        deps(configWith({ "antigravity-cli": { enabled: false } })).value,
      ),
      [],
    );
    assert.deepEqual(await listAntigravityUsage(deps(configWith(ENABLED), { platform: "linux" }).value), []);
  });

  it("is unavailable without a login and an error card on a server failure", async () => {
    const noLogin = await (await freshModule()).listAntigravityUsage(
      deps(configWith(ENABLED), { keychain: null }).value,
    );
    assert.equal(noLogin[0]?.status, "unavailable");

    const expired = await (await freshModule()).listAntigravityUsage(
      deps(configWith(ENABLED), { status: 401 }).value,
    );
    assert.equal(expired[0]?.status, "unavailable");

    const failed = await (await freshModule()).listAntigravityUsage(
      deps(configWith(ENABLED), { status: 503 }).value,
    );
    assert.equal(failed[0]?.status, "error");
    assert.match(failed[0]?.error ?? "", /503/);
  });

  it("serves the cached card on the next poll", async () => {
    const { listAntigravityUsage } = await freshModule();
    const fake = deps(configWith(ENABLED));
    await listAntigravityUsage(fake.value);
    await listAntigravityUsage(fake.value);
    assert.equal(fake.requests.length, 1);
  });
});

describe("scoped 5-hour labels", () => {
  it("codes rolling windows compactly without model suffix and localizes full labels", () => {
    const window = { id: "five_hour_gemini", label: "Session · Gemini" };
    assert.equal(windowShortLabel(window), "5H");
    assert.equal(windowLabel(window, messagesFor("en")), "5-hour session (Gemini)");
    assert.equal(windowLabel(window, messagesFor("ru")), "5-часовой лимит (Gemini)");

    const weeklyGemini = { id: "weekly_gemini", label: "Weekly · Gemini" };
    assert.equal(windowShortLabel(weeklyGemini), "1W");
    assert.equal(windowLabel(weeklyGemini, messagesFor("en")), "Weekly (Gemini)");
    assert.equal(windowLabel(weeklyGemini, messagesFor("ru")), "Недельный лимит (Gemini)");

    const other5h = { id: "five_hour_3p", label: "Session · Other models" };
    assert.equal(windowShortLabel(other5h), "5H");
    assert.equal(windowLabel(other5h, messagesFor("en")), "5-hour session (Other models)");
    assert.equal(windowLabel(other5h, messagesFor("ru")), "5-часовой лимит (Остальные модели)");

    const otherWeekly = { id: "weekly_3p", label: "Weekly · Other models" };
    assert.equal(windowShortLabel(otherWeekly), "1W");
    assert.equal(windowLabel(otherWeekly, messagesFor("en")), "Weekly (Other models)");
    assert.equal(windowLabel(otherWeekly, messagesFor("ru")), "Недельный лимит (Остальные модели)");
  });
});
