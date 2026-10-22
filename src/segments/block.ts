import { debug } from "../utils/logger.js";
import type { OAuthUsageResponse } from "../utils/oauth.js";

export interface BlockInfo {
  percentUsed: number | null;
  resetAt: Date | null;
  timeRemaining: number | null; // minutes
  isRealtime: boolean;
}

export class BlockProvider {
  // `usage` is resolved once per render (see resolveUsage).
  getBlockInfo(usage: OAuthUsageResponse | null): BlockInfo {
    const fiveHour = usage?.fiveHour;
    if (!fiveHour) {
      debug("No block usage data available");
      return {
        percentUsed: null,
        resetAt: null,
        timeRemaining: null,
        isRealtime: false,
      };
    }

    // Calculate time remaining from reset time
    const timeRemaining = Math.max(
      0,
      Math.round((fiveHour.resetAt.getTime() - Date.now()) / (1000 * 60))
    );

    debug(
      `Block segment: ${fiveHour.percentUsed}% used, resets at ${fiveHour.resetAt}, ${timeRemaining}m remaining`
    );

    return {
      percentUsed: fiveHour.percentUsed,
      resetAt: fiveHour.resetAt,
      timeRemaining,
      isRealtime: true,
    };
  }
}
