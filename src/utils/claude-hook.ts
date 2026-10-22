import { debug } from "./logger.js";
import type { OAuthUsageResponse } from "./oauth.js";

/**
 * One subscription usage window from the statusline stdin `rate_limits`.
 */
export interface RateLimitWindow {
  used_percentage?: number; // 0-100
  resets_at?: number; // epoch seconds
}

export interface RateLimits {
  five_hour?: RateLimitWindow | null;
  seven_day?: RateLimitWindow | null;
}

/**
 * Hook data passed by Claude Code via stdin
 */
export interface ClaudeHookData {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  model?: {
    id: string;
    display_name: string;
  };
  workspace?: {
    current_dir: string;
    project_dir: string;
  };
  context_window?: {
    current_usage: {
      input_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    };
    context_window_size: number;
  };
  // Claude.ai subscription usage; absent before the session's first API
  // response, null in an API-key session.
  rate_limits?: RateLimits | null;
  version?: string;
}

/**
 * Usage from the stdin `rate_limits`, or null when it has no usable window,
 * in which case the caller falls back to the OAuth usage API. Stdin has no
 * per-model weekly windows, so those stay null.
 */
export function usageFromRateLimits(
  rateLimits: RateLimits | null | undefined
): OAuthUsageResponse | null {
  const toUsage = (w: RateLimitWindow | null | undefined) =>
    typeof w?.used_percentage === "number" && typeof w.resets_at === "number"
      ? {
          percentUsed: w.used_percentage,
          resetAt: new Date(w.resets_at * 1000),
          isOverLimit: w.used_percentage >= 100,
        }
      : null;

  const fiveHour = toUsage(rateLimits?.five_hour);
  const sevenDay = toUsage(rateLimits?.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay, sevenDayOpus: null, sevenDaySonnet: null };
}

/**
 * Read hook data from stdin (non-blocking with timeout)
 */
export async function readHookData(): Promise<ClaudeHookData | null> {
  // If stdin is a TTY (interactive terminal), no hook data
  if (process.stdin.isTTY) {
    debug("stdin is TTY, no hook data");
    return null;
  }

  try {
    const chunks: Buffer[] = [];

    // Read with a short timeout
    const result = await Promise.race([
      new Promise<string>((resolve, reject) => {
        process.stdin.on("data", (chunk) => chunks.push(chunk));
        process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        process.stdin.on("error", reject);
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);

    if (!result || result.trim() === "") {
      debug("No stdin data received");
      return null;
    }

    const hookData = JSON.parse(result) as ClaudeHookData;
    debug("Hook data received:", JSON.stringify(hookData));
    return hookData;
  } catch (error) {
    debug("Error reading hook data:", error);
    return null;
  }
}

/**
 * Format model name for compact display
 */
export function formatModelName(modelId: string, displayName?: string): string {
  // If we have a display name that's reasonable, use it
  if (displayName && displayName.length <= 20) {
    // Clean up display name
    const clean = displayName.replace(/^Claude\s*/i, "").trim();
    if (clean) return clean;
  }

  // Common model ID mappings
  const mappings: Record<string, string> = {
    "claude-opus-4-6": "Opus 4.6",
    "claude-sonnet-4-6": "Sonnet 4.6",
    "claude-haiku-4-5-20251001": "Haiku 4.5",
    "claude-opus-4-5-20251101": "Opus 4.5",
    "claude-opus-4-20250514": "Opus 4",
    "claude-sonnet-4-20250514": "Sonnet 4",
    "claude-3-5-sonnet-20241022": "Sonnet 3.5",
    "claude-3-5-sonnet-latest": "Sonnet 3.5",
    "claude-3-5-sonnet": "Sonnet 3.5",
    "claude-3-opus-20240229": "Opus 3",
    "claude-3-opus": "Opus 3",
    "claude-3-sonnet-20240229": "Sonnet 3",
    "claude-3-haiku-20240307": "Haiku 3",
    "claude-3-haiku": "Haiku 3",
  };

  // Check for exact match
  if (mappings[modelId]) {
    return mappings[modelId];
  }

  // Try to extract a friendly name from model ID
  const lower = modelId.toLowerCase();

  if (lower.includes("opus")) {
    if (lower.includes("4-6") || lower.includes("4.6")) return "Opus 4.6";
    if (lower.includes("4-5") || lower.includes("4.5")) return "Opus 4.5";
    if (lower.includes("4")) return "Opus 4";
    if (lower.includes("3")) return "Opus 3";
    return "Opus";
  }
  if (lower.includes("sonnet")) {
    if (lower.includes("4-6") || lower.includes("4.6")) return "Sonnet 4.6";
    if (lower.includes("4-5") || lower.includes("4.5")) return "Sonnet 4.5";
    if (lower.includes("4")) return "Sonnet 4";
    if (lower.includes("3-5") || lower.includes("3.5")) return "Sonnet 3.5";
    if (lower.includes("3")) return "Sonnet 3";
    return "Sonnet";
  }
  if (lower.includes("haiku")) {
    if (lower.includes("4-5") || lower.includes("4.5")) return "Haiku 4.5";
    if (lower.includes("3")) return "Haiku 3";
    return "Haiku";
  }

  // Return truncated original if no mapping
  return modelId.length > 15 ? modelId.slice(0, 15) : modelId;
}
