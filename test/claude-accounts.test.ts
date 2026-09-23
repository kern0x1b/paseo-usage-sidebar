/**
 * Extra Claude accounts read from Paseo's config.json, against a temp config, a
 * fake Keychain and a fake usage API.
 *
 * Run: npm test
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ProviderUsage } from "../shared/usage/contract";

type Module = typeof import("../server/usage/claude-accounts");

/** The module caches per provider id, so each test gets its own instance. */
let instance = 0;
async function freshModule(): Promise<Module> {
  instance += 1;
  return (await import(`../server/usage/claude-accounts.ts?case=${instance}`)) as Module;
}

const WORK_DIR = "/Users/someone/.claude-work";

function configWith(providers: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "usage-sidebar-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ agents: { providers } }));
  return path;
}

const WORK_PROVIDER = {
  extends: "claude",
  label: "Claude Work",
  env: { CLAUDE_CONFIG_DIR: WORK_DIR },
  enabled: true,
};

const CREDENTIALS = JSON.stringify({
  claudeAiOauth: { accessToken: "token-work", subscriptionType: "team", rateLimitTier: "default_claude_max_5x" },
});

function deps(
  configPath: string,
  options: { status?: number; body?: unknown; keychain?: Record<string, string> } = {},
) {
  const services: string[] = [];
  const tokens: string[] = [];
  let calls = 0;
  const keychain = options.keychain ?? { [""]: CREDENTIALS };
  return {
    services,
    tokens,
    calls: () => calls,
    value: {
      configPath,
      platform: "darwin" as const,
      now: () => 0,
      runSecurity: async (args: string[]) => {
        const service = args[args.indexOf("-s") + 1] ?? "";
        services.push(service);
        return keychain[service] ?? keychain[""] ?? null;
      },
      fetch: (async (_url: string, init: { headers: Record<string, string> }) => {
        calls += 1;
        tokens.push(init.headers.Authorization ?? "");
        return new Response(JSON.stringify(options.body ?? {}), { status: options.status ?? 200 });
      }) as unknown as typeof fetch,
    },
  };
}

describe("readClaudeAccounts", () => {
  it("lists only enabled claude-based providers with their own config dir", async () => {
    const { readClaudeAccounts } = await freshModule();
    const path = configWith({
      "claude-work": WORK_PROVIDER,
      "claude-default": { extends: "claude", label: "Same login" },
      "claude-off": { ...WORK_PROVIDER, enabled: false },
      "codex-work": { extends: "codex", env: { CLAUDE_CONFIG_DIR: WORK_DIR } },
    });
    assert.deepEqual(readClaudeAccounts(path), [
      { providerId: "claude-work", displayName: "Claude Work", configDir: WORK_DIR },
    ]);
  });

  it("returns nothing for a missing or broken config", async () => {
    const { readClaudeAccounts } = await freshModule();
    assert.deepEqual(readClaudeAccounts("/nonexistent/config.json"), []);
  });
});

describe("keychainServiceFor", () => {
  it("matches Claude Code's hashed service name", async () => {
    const { keychainServiceFor } = await freshModule();
    assert.equal(keychainServiceFor("/Users/you/.claude-work"), "Claude Code-credentials-f7aef36f");
  });
});

describe("listClaudeAccountUsage", () => {
  it("reads the account's own Keychain item and builds the daemon's windows", async () => {
    const { listClaudeAccountUsage, keychainServiceFor } = await freshModule();
    const host = deps(configWith({ "claude-work": WORK_PROVIDER }), {
      keychain: { [keychainServiceFor(WORK_DIR)]: CREDENTIALS },
      body: {
        five_hour: { utilization: 19, resets_at: "2026-09-23T17:00:00Z" },
        seven_day: { utilization: 95, resets_at: "2026-09-25T02:00:00Z" },
        seven_day_opus: { utilization: 1 },
        limits: [
          { kind: "weekly_scoped", percent: 40, scope: { model: { id: "opus", display_name: "Opus" } } },
          { kind: "other", percent: 99 },
        ],
        extra_usage: { is_enabled: false },
      },
    });

    const [usage] = await listClaudeAccountUsage(host.value);

    assert.deepEqual(host.tokens, ["Bearer token-work"]);
    assert.equal(host.services[0], keychainServiceFor(WORK_DIR));
    assert.equal(usage?.providerId, "claude-work");
    assert.equal(usage?.displayName, "Claude Work");
    assert.equal(usage?.status, "available");
    assert.equal(usage?.planLabel, "Team 5x");
    assert.deepEqual(
      usage?.windows.map((window) => [window.id, window.label, window.usedPct, window.tone]),
      [
        ["five_hour", "Session", 19, "ok"],
        ["weekly", "Weekly", 95, "danger"],
        ["weekly_model_opus", "Weekly · Opus", 40, "ok"],
      ],
    );
    assert.deepEqual(usage?.details, [{ id: "extra_usage", label: "Extra usage", value: "Disabled" }]);
  });

  it("reports an account without credentials as unavailable, without calling the API", async () => {
    const { listClaudeAccountUsage } = await freshModule();
    const host = deps(configWith({ "claude-work": WORK_PROVIDER }), { keychain: {} });
    const [usage] = await listClaudeAccountUsage(host.value);
    assert.equal(usage?.status, "unavailable");
    assert.equal(host.calls(), 0);
  });

  it("reports an expired token as unavailable and a server failure as an error", async () => {
    const expired = await (await freshModule()).listClaudeAccountUsage(
      deps(configWith({ "claude-work": WORK_PROVIDER }), { status: 401 }).value,
    );
    assert.equal(expired[0]?.status, "unavailable");

    const failed = await (await freshModule()).listClaudeAccountUsage(
      deps(configWith({ "claude-work": WORK_PROVIDER }), { status: 500 }).value,
    );
    assert.equal(failed[0]?.status, "error");
    assert.match(failed[0]?.error ?? "", /500/);
  });

  it("refetches once a cached window has reset, before the TTL runs out", async () => {
    const { listClaudeAccountUsage } = await freshModule();
    let nowMs = Date.parse("2026-09-23T13:00:00Z");
    const host = deps(configWith({ "claude-work": WORK_PROVIDER }), {
      body: { five_hour: { utilization: 100, resets_at: "2026-09-23T13:01:00Z" } },
    });
    const value = { ...host.value, now: () => nowMs };
    await listClaudeAccountUsage(value);
    nowMs += 30_000;
    await listClaudeAccountUsage(value);
    assert.equal(host.calls(), 1);
    nowMs += 60_000;
    await listClaudeAccountUsage(value);
    assert.equal(host.calls(), 2);
  });

  it("serves a second poll from cache", async () => {
    const { listClaudeAccountUsage } = await freshModule();
    const host = deps(configWith({ "claude-work": WORK_PROVIDER }));
    await listClaudeAccountUsage(host.value);
    await listClaudeAccountUsage(host.value);
    assert.equal(host.calls(), 1);
  });
});

describe("withClaudeAccounts", () => {
  const card = (providerId: string) => ({ providerId }) as ProviderUsage;

  it("places extra accounts right after the default Claude card", async () => {
    const { withClaudeAccounts } = await freshModule();
    const merged = withClaudeAccounts([card("claude"), card("codex")], [card("claude-work")]);
    assert.deepEqual(merged.map((provider) => provider.providerId), ["claude", "claude-work", "codex"]);
  });

  it("appends when there is no default card and never duplicates a daemon provider", async () => {
    const { withClaudeAccounts } = await freshModule();
    assert.deepEqual(
      withClaudeAccounts([card("codex")], [card("claude-work"), card("codex")]).map((provider) => provider.providerId),
      ["codex", "claude-work"],
    );
  });
});
