import { debug } from "../utils/logger.js";
import type { OAuthUsageResponse } from "../utils/oauth.js";

export interface WeeklyInfo {
  percentUsed: number | null;
  resetAt: Date | null;
  isRealtime: boolean;
  weekProgressPercent: number;
  // Model-specific weekly limits
  opusPercentUsed: number | null;
  sonnetPercentUsed: number | null;
  opusResetAt: Date | null;
  sonnetResetAt: Date | null;
}

export class WeeklyProvider {
  private calculateWeekProgress(
    resetDay?: number,
    resetHour?: number,
    resetMinute?: number
  ): number {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0=Sunday, 1=Monday, ..., 6=Saturday
    const hours = now.getHours();
    const minutes = now.getMinutes();

    // Default to Monday 00:00 if no reset time specified
    const targetDay = resetDay ?? 1; // Monday
    const targetHour = resetHour ?? 0;
    const targetMinute = resetMinute ?? 0;

    // Calculate days since last reset
    // If we're before the reset time on reset day, we're still in the previous week
    let daysSinceReset = (dayOfWeek - targetDay + 7) % 7;

    // Check if we're on reset day but before reset time
    if (daysSinceReset === 0) {
      const currentMinutes = hours * 60 + minutes;
      const resetMinutes = targetHour * 60 + targetMinute;
      if (currentMinutes < resetMinutes) {
        daysSinceReset = 7; // Still in previous week's period
      }
    }

    // Calculate hours into the current week period
    const hoursIntoWeek =
      daysSinceReset * 24 +
      hours -
      targetHour +
      (minutes - targetMinute) / 60;

    const totalHoursInWeek = 7 * 24;

    // Clamp to 0-100%
    const progress = Math.max(0, Math.min(100, (hoursIntoWeek / totalHoursInWeek) * 100));
    return Math.round(progress);
  }

  private calculateWeekProgressFromResetTime(resetAt: Date): number {
    const now = new Date();
    const resetTime = new Date(resetAt);

    // Calculate the start of this period (7 days before reset)
    const periodStart = new Date(resetTime);
    periodStart.setDate(periodStart.getDate() - 7);

    // Past the reset time: the window repeats weekly, so measure from the
    // latest reset, however many weeks ago the known one was.
    if (now > resetTime) {
      const weekMs = 7 * 24 * 60 * 60 * 1000;
      const elapsedMs = (now.getTime() - resetTime.getTime()) % weekMs;
      return Math.round((elapsedMs / weekMs) * 100);
    }

    // Calculate progress through current period
    const totalMs = resetTime.getTime() - periodStart.getTime();
    const elapsedMs = now.getTime() - periodStart.getTime();

    const progress = Math.max(0, Math.min(100, (elapsedMs / totalMs) * 100));
    return Math.round(progress);
  }

  // `usage` is resolved once per render (see resolveUsage).
  getWeeklyInfo(
    usage: OAuthUsageResponse | null,
    resetDay?: number,
    resetHour?: number,
    resetMinute?: number
  ): WeeklyInfo {
    const sevenDay = usage?.sevenDay;
    if (!sevenDay) {
      // Fallback to estimate mode
      debug("No weekly usage data available, falling back to estimate mode");
      return {
        percentUsed: null,
        resetAt: null,
        isRealtime: false,
        weekProgressPercent: this.calculateWeekProgress(resetDay, resetHour, resetMinute),
        opusPercentUsed: null,
        sonnetPercentUsed: null,
        opusResetAt: null,
        sonnetResetAt: null,
      };
    }

    const sevenDayOpus = usage.sevenDayOpus;
    const sevenDaySonnet = usage.sevenDaySonnet;

    // Calculate week progress based on the window's reset time
    const weekProgressPercent = this.calculateWeekProgressFromResetTime(sevenDay.resetAt);

    debug(`Weekly segment: ${sevenDay.percentUsed}% used, resets at ${sevenDay.resetAt}`);
    if (sevenDayOpus) {
      debug(`Weekly Opus: ${sevenDayOpus.percentUsed}% used`);
    }
    if (sevenDaySonnet) {
      debug(`Weekly Sonnet: ${sevenDaySonnet.percentUsed}% used`);
    }

    return {
      percentUsed: sevenDay.percentUsed,
      resetAt: sevenDay.resetAt,
      isRealtime: true,
      weekProgressPercent,
      opusPercentUsed: sevenDayOpus?.percentUsed ?? null,
      sonnetPercentUsed: sevenDaySonnet?.percentUsed ?? null,
      opusResetAt: sevenDayOpus?.resetAt ?? null,
      sonnetResetAt: sevenDaySonnet?.resetAt ?? null,
    };
  }
}
