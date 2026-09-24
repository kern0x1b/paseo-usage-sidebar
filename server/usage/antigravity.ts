import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ProviderUsageSchema,
  type ProviderUsage,
  type UsageWindow,
} from "../../shared/usage/contract";
import { isRecord, toneFor } from "./claude-accounts";

/**
 * Antigravity runs in Paseo through the `antigravity-cli` plugin, which reports no
 * plan usage, so the daemon has no card for it. `agy` keeps its Google OAuth token in
 * the Keychain and refreshes it itself; like the Claude accounts, the token is only
 * read here, never refreshed.
 *
 * The quota comes from the same call `agy /usage` makes. It answers with one group per
 * model family (Gemini; Claude and GPT), each carrying a 5-hour and a weekly bucket.
 * The endpoint rejects a client that does not name itself `antigravity` in its
 * User-Agent with SUBSCRIPTION_REQUIRED.
 */

export const ANTIGRAVITY_PROVIDER_ID = "antigravity-cli";

export interface AntigravityDeps {
  configPath: string;
  platform: NodeJS.Platform;
  runSecurity: (args: string[]) => Promise<string | null>;
  fetch: typeof fetch;
  now: () => number;
}

const QUOTA_URL =
  "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const USER_AGENT = "paseo-usage-sidebar antigravity";
const KEYCHAIN_SERVICE = "gemini";
const KEYCHAIN_ACCOUNT = "antigravity";
const KEYRING_PREFIX = "go-keyring-base64:";
const KEYCHAIN_TIMEOUT_MS = 2000;
const HTTP_TIMEOUT_MS = 15000;
/** Same TTL as the Claude accounts, so every card goes stale together. */
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

function defaultDeps(): AntigravityDeps {
  return {
    configPath: paseoConfigPath(),
    platform: process.platform,
    runSecurity,
    fetch: (input, init) => fetch(input, init),
    now: Date.now,
  };
}

/** Only someone who runs Antigravity through Paseo gets a card for it. */
export function antigravityPluginEnabled(configPath: string): boolean {
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return false;
  }
  const plugins = isRecord(config) ? config.plugins : undefined;
  const plugin = isRecord(plugins)
    ? plugins[ANTIGRAVITY_PROVIDER_ID]
    : undefined;
  return isRecord(plugin) && plugin.enabled !== false;
}

/** go-keyring stores `go-keyring-base64:<base64 of {"token":{"access_token":...}}>`. */
export function accessTokenFrom(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  try {
    const json = raw.startsWith(KEYRING_PREFIX)
      ? Buffer.from(raw.slice(KEYRING_PREFIX.length), "base64").toString("utf8")
      : raw;
    const parsed = JSON.parse(json) as { token?: { access_token?: unknown } };
    const token = parsed.token?.access_token;
    return typeof token === "string" && token ? token : null;
  } catch {
    return null;
  }
}

/** Map quota group to scope name: Gemini → "Gemini", 3p/other → "Other models". */
function scopeName(groupName: string, bucketId: string): string {
  if (bucketId.startsWith("gemini") || /gemini/i.test(groupName)) {
    return "Gemini";
  }
  return "Other models";
}

/** "gemini-5h" → "gemini", so the window ids stay stable across label changes. */
function scopeId(bucketId: string): string {
  return bucketId.replace(/-(5h|weekly)$/, "").replace(/[^a-zA-Z0-9]+/g, "_");
}

function toWindow(bucket: unknown, groupName: string): UsageWindow | null {
  if (!isRecord(bucket) || typeof bucket.bucketId !== "string") {
    return null;
  }
  const scope = scopeName(groupName, bucket.bucketId);
  const period =
    bucket.window === "5h"
      ? {
          id: `five_hour_${scopeId(bucket.bucketId)}`,
          label: `Session · ${scope}`,
        }
      : bucket.window === "weekly"
        ? {
            id: `weekly_${scopeId(bucket.bucketId)}`,
            label: `Weekly · ${scope}`,
          }
        : {
            id: bucket.bucketId,
            label: `${typeof bucket.displayName === "string" ? bucket.displayName : bucket.bucketId} · ${scope}`,
          };
  const remaining = Number(bucket.remainingFraction);
  const usedPct =
    bucket.remainingFraction == null || !Number.isFinite(remaining)
      ? null
      : Math.min(100, Math.max(0, (1 - remaining) * 100));
  return {
    ...period,
    usedPct,
    remainingPct: usedPct === null ? null : 100 - usedPct,
    resetsAt: typeof bucket.resetTime === "string" ? bucket.resetTime : null,
    tone: toneFor(usedPct),
  };
}

export function windowsFromQuotaSummary(
  response: Record<string, unknown>,
): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const group of Array.isArray(response.groups) ? response.groups : []) {
    if (!isRecord(group) || !Array.isArray(group.buckets)) {
      continue;
    }
    const groupName =
      typeof group.displayName === "string" ? group.displayName : "";
    // The 5-hour bucket first in each group, as the Claude cards order them.
    const ordered = [...group.buckets].sort(
      (left, right) =>
        Number(isRecord(right) && right.window === "5h") -
        Number(isRecord(left) && left.window === "5h"),
    );
    for (const bucket of ordered) {
      const window = toWindow(bucket, groupName);
      if (window) {
        windows.push(window);
      }
    }
  }
  return windows;
}

function unavailable(error: string | null = null): ProviderUsage {
  return ProviderUsageSchema.parse({
    providerId: ANTIGRAVITY_PROVIDER_ID,
    displayName: "Antigravity",
    status: error ? "error" : "unavailable",
    planLabel: null,
    error,
  });
}

async function fetchUsage(deps: AntigravityDeps): Promise<ProviderUsage> {
  const token = accessTokenFrom(
    await deps.runSecurity([
      "find-generic-password",
      "-a",
      KEYCHAIN_ACCOUNT,
      "-w",
      "-s",
      KEYCHAIN_SERVICE,
    ]),
  );
  if (!token) {
    return unavailable();
  }
  const response = await deps.fetch(QUOTA_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: "{}",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) {
    return unavailable();
  }
  if (!response.ok) {
    return unavailable(`Antigravity quota API returned ${response.status}`);
  }
  const body = (await response.json()) as unknown;
  return ProviderUsageSchema.parse({
    providerId: ANTIGRAVITY_PROVIDER_ID,
    displayName: "Antigravity",
    status: "available",
    planLabel: null,
    windows: isRecord(body) ? windowsFromQuotaSummary(body) : [],
  });
}

let cached: {
  fetchedAtMs: number;
  usage: Promise<ProviderUsage>;
  nextResetMs: number;
} | null = null;

function earliestReset(usage: ProviderUsage): number {
  const resets = usage.windows
    .map((window) =>
      window.resetsAt ? new Date(window.resetsAt).getTime() : Number.NaN,
    )
    .filter(Number.isFinite);
  return resets.length > 0 ? Math.min(...resets) : Number.POSITIVE_INFINITY;
}

/**
 * The Antigravity card, or nothing when the plugin is not enabled or this is not a
 * Mac (the token lives in the Keychain). Never throws: a failure becomes an `error`
 * card instead of taking the daemon's providers down with it.
 */
export async function listAntigravityUsage(
  deps: AntigravityDeps = defaultDeps(),
): Promise<ProviderUsage[]> {
  if (
    deps.platform !== "darwin" ||
    !antigravityPluginEnabled(deps.configPath)
  ) {
    return [];
  }
  const nowMs = deps.now();
  if (
    cached &&
    nowMs - cached.fetchedAtMs < CACHE_TTL_MS &&
    nowMs < cached.nextResetMs
  ) {
    return [await cached.usage];
  }
  const usage = fetchUsage(deps).catch((error: unknown) =>
    unavailable(error instanceof Error ? error.message : String(error)),
  );
  const entry = {
    fetchedAtMs: nowMs,
    usage,
    nextResetMs: Number.POSITIVE_INFINITY,
  };
  void usage.then((resolved) => {
    entry.nextResetMs = earliestReset(resolved);
  });
  cached = entry;
  return [await usage];
}
