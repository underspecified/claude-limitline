import { debug } from "./logger.js";
import type { RateLimits, RateLimitWindow } from "./claude-hook.js";
import {
  getRealtimeUsage,
  getUsageTrend,
  isLimitlineAuthFailing,
  toUsageData,
  type OAuthUsageResponse,
  type TrendInfo,
  type UsageData,
} from "./oauth.js";

export interface StdinUsage {
  fiveHour: UsageData | null;
  sevenDay: UsageData | null;
}

// No real window resets further out than a week; this also rejects a
// resets_at given in milliseconds.
const MAX_RESET_AHEAD_MS = 8 * 24 * 60 * 60 * 1000;

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

function windowUsage(w: RateLimitWindow | null | undefined, now: number): UsageData | null {
  if (!isFiniteNumber(w?.used_percentage) || !isFiniteNumber(w.resets_at)) return null;
  const resetMs = w.resets_at * 1000;
  if (resetMs > now + MAX_RESET_AHEAD_MS) return null;
  // Stdin updates only on an API response, so a window past its reset has
  // rolled over even though stdin still carries the old percentage.
  return toUsageData(resetMs <= now ? 0 : w.used_percentage, new Date(resetMs));
}

/**
 * Each usable window of the stdin `rate_limits`; a window that is missing or
 * malformed is null, and the caller falls back to the OAuth path for it.
 */
export function usageFromRateLimits(
  rateLimits: RateLimits | null | undefined,
  now: number = Date.now()
): StdinUsage {
  return {
    fiveHour: windowUsage(rateLimits?.five_hour, now),
    sevenDay: windowUsage(rateLimits?.seven_day, now),
  };
}

export interface UsageRequest {
  pollInterval: number;
  showTrend: boolean;
  fiveHour: boolean; // block segment enabled
  sevenDay: boolean; // weekly segment enabled
}

export interface ResolvedUsage {
  usage: OAuthUsageResponse | null;
  trendInfo: TrendInfo | null;
  authFailing: boolean;
}

/**
 * Resolve each budget window once per render. A usable window in the stdin
 * `rate_limits` wins; any other enabled window falls back to the OAuth path
 * (API or shared cache). Trend arrows and `auth!` describe that path's cache
 * and credential, so they apply only to windows that came from it.
 */
export async function resolveUsage(
  rateLimits: RateLimits | null | undefined,
  request: UsageRequest,
  now: number = Date.now()
): Promise<ResolvedUsage> {
  const stdin = usageFromRateLimits(rateLimits, now);
  const fiveHourFallback = request.fiveHour && !stdin.fiveHour;
  const sevenDayFallback = request.sevenDay && !stdin.sevenDay;
  debug(
    `Usage source: five_hour ${fiveHourFallback ? "OAuth" : "stdin"}, seven_day ${sevenDayFallback ? "OAuth" : "stdin"}`
  );

  if (!fiveHourFallback && !sevenDayFallback) {
    return {
      usage: { ...stdin, sevenDayOpus: null, sevenDaySonnet: null },
      trendInfo: null,
      authFailing: false,
    };
  }

  let api: OAuthUsageResponse | null = null;
  try {
    api = await getRealtimeUsage(request.pollInterval);
  } catch (error) {
    debug("Error getting realtime usage:", error);
  }

  // Per-model weekly windows exist only on the OAuth path; pair them only
  // with an overall weekly window from the same source.
  const usage: OAuthUsageResponse = {
    fiveHour: stdin.fiveHour ?? api?.fiveHour ?? null,
    sevenDay: stdin.sevenDay ?? api?.sevenDay ?? null,
    sevenDayOpus: stdin.sevenDay ? null : (api?.sevenDayOpus ?? null),
    sevenDaySonnet: stdin.sevenDay ? null : (api?.sevenDaySonnet ?? null),
  };

  const trend = request.showTrend ? getUsageTrend() : null;
  const trendInfo: TrendInfo | null = trend && {
    fiveHourTrend: stdin.fiveHour ? null : trend.fiveHourTrend,
    sevenDayTrend: stdin.sevenDay ? null : trend.sevenDayTrend,
    sevenDayOpusTrend: stdin.sevenDay ? null : trend.sevenDayOpusTrend,
    sevenDaySonnetTrend: stdin.sevenDay ? null : trend.sevenDaySonnetTrend,
  };

  // `auth!` renders only in place of a window with no data, and a stdin
  // window always has data, so it can land only on a fallback window.
  return { usage, trendInfo, authFailing: isLimitlineAuthFailing() };
}
