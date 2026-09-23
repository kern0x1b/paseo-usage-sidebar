import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import {
  ProviderUsageSchema,
  type ProviderUsage,
  type UsageTone,
  type UsageWindow,
} from "../../shared/usage/contract";

/**
 * The daemon's quota fetcher knows exactly one Claude account: `~/.claude` or the
 * default Keychain item. A custom provider in `config.json` that `extends: "claude"`
 * with its own `CLAUDE_CONFIG_DIR` is a second login the daemon never asks about, so
 * its usage is read here, the same way the daemon reads the default one: credentials
 * are only read, never refreshed, because the Claude CLI owns refresh.
 */

export interface ClaudeAccount {
  providerId: string;
  displayName: string;
  configDir: string;
}

export interface ClaudeAccountDeps {
  configPath: string;
  platform: NodeJS.Platform;
  runSecurity: (args: string[]) => Promise<string | null>;
  fetch: typeof fetch;
  now: () => number;
}

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const KEYCHAIN_TIMEOUT_MS = 2000;
const HTTP_TIMEOUT_MS = 15000;
/** Same TTL as the daemon's usage cache, so both accounts go stale together. */
const CACHE_TTL_MS = 5 * 60 * 1000;

function paseoConfigPath(): string {
  const home = process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo");
  return join(home, "config.json");
}

function runSecurity(args: string[]): Promise<string | null> {
  return new Promise((done) => {
    execFile(
      "security",
      args,
      { timeout: KEYCHAIN_TIMEOUT_MS },
      (error, stdout) => {
        done(error ? null : stdout.trim() || null);
      },
    );
  });
}

function defaultDeps(): ClaudeAccountDeps {
  return {
    configPath: paseoConfigPath(),
    platform: process.platform,
    runSecurity,
    fetch: (input, init) => fetch(input, init),
    now: Date.now,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Enabled custom providers that extend `claude` and point at a config dir other than
 * the default one. A provider without `CLAUDE_CONFIG_DIR` shares the default login,
 * which the daemon already reports, so listing it would only duplicate that card.
 */
export function readClaudeAccounts(configPath: string): ClaudeAccount[] {
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return [];
  }
  const agents = isRecord(config) ? config.agents : undefined;
  const providers = isRecord(agents) ? agents.providers : undefined;
  if (!isRecord(providers)) {
    return [];
  }
  const defaultDir = resolve(homedir(), ".claude");
  const accounts: ClaudeAccount[] = [];
  for (const [providerId, provider] of Object.entries(providers)) {
    if (
      !isRecord(provider) ||
      provider.extends !== "claude" ||
      provider.enabled === false
    ) {
      continue;
    }
    const configDir = isRecord(provider.env)
      ? provider.env.CLAUDE_CONFIG_DIR
      : undefined;
    if (
      typeof configDir !== "string" ||
      !configDir.trim() ||
      resolve(configDir) === defaultDir
    ) {
      continue;
    }
    const label =
      typeof provider.label === "string" && provider.label.trim()
        ? provider.label
        : providerId;
    accounts.push({ providerId, displayName: label, configDir });
  }
  return accounts;
}

/**
 * Claude Code suffixes its Keychain service with the first 8 hex chars of the
 * sha256 of `CLAUDE_CONFIG_DIR` whenever that variable is set.
 */
export function keychainServiceFor(configDir: string): string {
  const hash = createHash("sha256")
    .update(configDir.normalize("NFC"))
    .digest("hex")
    .slice(0, 8);
  return `${KEYCHAIN_SERVICE}-${hash}`;
}

interface OAuthCredentials {
  accessToken: string;
  subscriptionType?: string;
  rateLimitTier?: string;
}

function oauthFrom(raw: string | null): OAuthCredentials | null {
  if (!raw) {
    return null;
  }
  try {
    const oauth = (
      JSON.parse(raw) as { claudeAiOauth?: Partial<OAuthCredentials> }
    ).claudeAiOauth;
    return typeof oauth?.accessToken === "string" && oauth.accessToken
      ? (oauth as OAuthCredentials)
      : null;
  } catch {
    return null;
  }
}

/** Mirrors the daemon's account derivation for the Keychain lookup. */
function keychainAccount(): string {
  const user = process.env.USER || userInfo().username;
  return /^[a-zA-Z0-9._-]+$/.test(user) ? user : "claude-code-user";
}

async function readCredentials(
  configDir: string,
  deps: ClaudeAccountDeps,
): Promise<OAuthCredentials | null> {
  const file = join(configDir, ".credentials.json");
  if (existsSync(file)) {
    const fromFile = oauthFrom(readFileSync(file, "utf8"));
    if (fromFile) {
      return fromFile;
    }
  }
  if (deps.platform !== "darwin") {
    return null;
  }
  // Account-scoped item first, then the legacy lookup, as the daemon does.
  const service = keychainServiceFor(configDir);
  for (const args of [
    ["find-generic-password", "-a", keychainAccount(), "-w", "-s", service],
    ["find-generic-password", "-w", "-s", service],
  ]) {
    const credentials = oauthFrom(await deps.runSecurity(args));
    if (credentials) {
      return credentials;
    }
  }
  return null;
}

function planLabel({
  subscriptionType,
  rateLimitTier,
}: OAuthCredentials): string | null {
  if (!subscriptionType) {
    return null;
  }
  const label =
    subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
  const tier = rateLimitTier?.split("_").pop();
  return tier ? `${label} ${tier}` : label;
}

/** Thresholds match the daemon's `toneFromUsedPct`. */
function toneFor(usedPct: number | null): UsageTone {
  if (usedPct === null) {
    return "default";
  }
  return usedPct > 90 ? "danger" : usedPct >= 70 ? "warning" : "ok";
}

function toWindow(
  id: string,
  label: string,
  source: unknown,
): UsageWindow | null {
  if (!isRecord(source)) {
    return null;
  }
  const raw = source.utilization ?? source.percent;
  const usedPct =
    raw == null || !Number.isFinite(Number(raw)) ? null : Number(raw);
  return {
    id,
    label,
    usedPct,
    remainingPct: usedPct === null ? null : Math.max(0, 100 - usedPct),
    resetsAt: typeof source.resets_at === "string" ? source.resets_at : null,
    tone: toneFor(usedPct),
  };
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const LEGACY_MODEL_WINDOWS = [
  ["seven_day_opus", "Opus"],
  ["seven_day_omelette", "Omelette"],
] as const;

/**
 * The same windows the daemon builds for the default account, with the same ids, so
 * the two cards read alike and pins survive refreshes. A `limits[]` entry replaces
 * the legacy top-level key for the same model.
 */
export function windowsFromResponse(
  response: Record<string, unknown>,
): UsageWindow[] {
  const unscoped = [
    toWindow("five_hour", "Session", response.five_hour),
    toWindow("weekly", "Weekly", response.seven_day),
  ];
  const scoped = new Map<string, UsageWindow | null>();
  for (const [field, name] of LEGACY_MODEL_WINDOWS) {
    const key = `model:${normalizeName(name)}`;
    scoped.set(
      key,
      toWindow(
        `weekly_model_${normalizeName(name)}`,
        `Weekly · ${name}`,
        response[field],
      ),
    );
  }
  for (const limit of Array.isArray(response.limits) ? response.limits : []) {
    if (
      !isRecord(limit) ||
      limit.kind !== "weekly_scoped" ||
      !isRecord(limit.scope)
    ) {
      continue;
    }
    for (const dimension of ["model", "surface"] as const) {
      const entry = limit.scope[dimension];
      const id =
        isRecord(entry) && typeof entry.id === "string" ? entry.id.trim() : "";
      const displayName =
        isRecord(entry) && typeof entry.display_name === "string"
          ? entry.display_name.trim()
          : "";
      const name = displayName || id;
      if (!name) {
        continue;
      }
      const key = `${dimension}:${normalizeName(name)}`;
      scoped.set(
        key,
        toWindow(
          `weekly_${dimension}_${id || normalizeName(name)}`,
          `Weekly · ${name}`,
          limit,
        ),
      );
      break;
    }
  }
  return [...unscoped, ...scoped.values()].filter(
    (window): window is UsageWindow => window !== null,
  );
}

function unavailable(
  account: ClaudeAccount,
  error: string | null = null,
): ProviderUsage {
  return ProviderUsageSchema.parse({
    providerId: account.providerId,
    displayName: account.displayName,
    status: error ? "error" : "unavailable",
    planLabel: null,
    error,
  });
}

async function fetchAccountUsage(
  account: ClaudeAccount,
  deps: ClaudeAccountDeps,
): Promise<ProviderUsage> {
  const credentials = await readCredentials(account.configDir, deps);
  if (!credentials) {
    return unavailable(account);
  }
  const response = await deps.fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      Accept: "application/json",
      "anthropic-beta": OAUTH_BETA,
    },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) {
    return unavailable(account);
  }
  if (!response.ok) {
    return unavailable(account, `Claude usage API returned ${response.status}`);
  }
  const body = (await response.json()) as unknown;
  const extraUsage =
    isRecord(body) && isRecord(body.extra_usage)
      ? body.extra_usage.is_enabled
      : undefined;
  return ProviderUsageSchema.parse({
    providerId: account.providerId,
    displayName: account.displayName,
    status: "available",
    planLabel: planLabel(credentials),
    windows: isRecord(body) ? windowsFromResponse(body) : [],
    details:
      typeof extraUsage === "boolean"
        ? [
            {
              id: "extra_usage",
              label: "Extra usage",
              value: extraUsage ? "Enabled" : "Disabled",
            },
          ]
        : [],
  });
}

const cache = new Map<
  string,
  { key: string; fetchedAtMs: number; usage: Promise<ProviderUsage> }
>();

/**
 * Usage for every extra Claude account, one entry per provider. `config.json` is
 * re-read on each call so a provider added or disabled in Settings shows up without
 * reloading the plugin. Never throws: a failing account becomes an `error` card
 * instead of taking the daemon's providers down with it.
 */
export async function listClaudeAccountUsage(
  deps: ClaudeAccountDeps = defaultDeps(),
): Promise<ProviderUsage[]> {
  const accounts = readClaudeAccounts(deps.configPath);
  const nowMs = deps.now();
  return Promise.all(
    accounts.map((account) => {
      const key = `${account.displayName}\0${account.configDir}`;
      const cached = cache.get(account.providerId);
      if (
        cached &&
        cached.key === key &&
        nowMs - cached.fetchedAtMs < CACHE_TTL_MS
      ) {
        return cached.usage;
      }
      const usage = fetchAccountUsage(account, deps).catch((error: unknown) =>
        unavailable(
          account,
          error instanceof Error ? error.message : String(error),
        ),
      );
      cache.set(account.providerId, { key, fetchedAtMs: nowMs, usage });
      return usage;
    }),
  );
}

/** Each extra account goes right after the daemon's own Claude card, or last if there is none. */
export function withClaudeAccounts(
  providers: ProviderUsage[],
  extra: ProviderUsage[],
): ProviderUsage[] {
  const known = new Set(providers.map((provider) => provider.providerId));
  const fresh = extra.filter((provider) => !known.has(provider.providerId));
  const claudeIndex = providers.findIndex(
    (provider) => provider.providerId === "claude",
  );
  if (claudeIndex === -1) {
    return [...providers, ...fresh];
  }
  return [
    ...providers.slice(0, claudeIndex + 1),
    ...fresh,
    ...providers.slice(claudeIndex + 1),
  ];
}
