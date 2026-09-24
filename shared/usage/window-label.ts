import type { Messages } from "../i18n/messages";
import type { UsageWindow } from "./contract";

/**
 * Paseo labels Claude's rolling windows "Session" and "Weekly · <model>". The
 * first says nothing about the actual period and the second is not localizable,
 * so the daemon's window ids are mapped onto this plugin's own message table
 * instead — which also means every label follows the app's language setting:
 *
 *   five_hour            → the 5-hour rolling window (labelled "Session")
 *   five_hour_<scope>    → a scoped 5-hour window, e.g. five_hour_gemini (Antigravity)
 *   weekly               → the 7-day window
 *   weekly_<model>       → a model-scoped 7-day window, e.g. weekly_model_fable
 *   daily / monthly      → other providers' fixed windows
 *   coding_limit_*, interval_*, everything else → keep the daemon's own label
 *
 * The model suffix is taken from the daemon's label ("Weekly · Fable") when it
 * has one, because that is the provider's display name for it; the id is only a
 * fallback for a label that does not follow the convention.
 */
function modelSuffix(window: UsageWindow): string | null {
  const separator = window.label.indexOf("·");
  if (separator >= 0) {
    const suffix = window.label.slice(separator + 1).trim();
    if (suffix) {
      return suffix;
    }
  }
  const fromId = window.id
    .replace(/^(weekly|five_hour)_(model_)?/, "")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!fromId) {
    return null;
  }
  return fromId.replace(/\b\w/g, (character) => character.toUpperCase());
}

export function windowLabel(window: UsageWindow, messages: Messages): string {
  if (window.id === "five_hour") {
    return messages.windowFiveHour;
  }
  if (window.id === "weekly") {
    return messages.windowWeekly;
  }
  if (window.id === "five_hour_gemini") {
    return messages.windowFiveHourGemini;
  }
  if (window.id === "weekly_gemini") {
    return messages.windowWeeklyGemini;
  }
  if (window.id === "five_hour_3p" || window.id === "five_hour_other" || window.id === "five_hour_other_models") {
    return messages.windowFiveHourOther;
  }
  if (window.id === "weekly_3p" || window.id === "weekly_other" || window.id === "weekly_other_models") {
    return messages.windowWeeklyOther;
  }
  if (window.id.startsWith("five_hour_")) {
    const suffix = modelSuffix(window);
    return suffix ? messages.windowScoped(messages.windowFiveHour, suffix) : messages.windowFiveHour;
  }
  if (window.id.startsWith("weekly_")) {
    const suffix = modelSuffix(window);
    return suffix ? messages.windowScoped(messages.windowWeekly, suffix) : messages.windowWeekly;
  }
  if (window.id === "daily") {
    return messages.windowDaily;
  }
  if (window.id === "monthly") {
    return messages.windowMonthly;
  }
  return window.label;
}

/**
 * A code short enough for a meter column: `5H`, `5H Gemini`, `1W`, `1W Fable`, `1D`, `1M`.
 * Language-neutral on purpose; the full localized label stays in the tooltip.
 */
export function windowShortLabel(window: UsageWindow): string {
  if (window.id === "five_hour") {
    return "5H";
  }
  if (window.id === "weekly") {
    return "1W";
  }
  if (window.id === "five_hour_gemini") {
    return "5H Gemini";
  }
  if (window.id === "weekly_gemini") {
    return "1W Gemini";
  }
  if (window.id === "five_hour_3p" || window.id === "five_hour_other" || window.id === "five_hour_other_models") {
    return "5H Other";
  }
  if (window.id === "weekly_3p" || window.id === "weekly_other" || window.id === "weekly_other_models") {
    return "1W Other";
  }
  if (window.id.startsWith("five_hour_")) {
    const suffix = modelSuffix(window);
    return suffix ? `5H ${suffix}` : "5H";
  }
  if (window.id.startsWith("weekly_")) {
    const suffix = modelSuffix(window);
    return suffix ? `1W ${suffix}` : "1W";
  }
  if (window.id === "daily") {
    return "1D";
  }
  if (window.id === "monthly") {
    return "1M";
  }
  return window.label;
}
