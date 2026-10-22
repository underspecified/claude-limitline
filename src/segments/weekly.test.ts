import { describe, it, expect, beforeEach } from "vitest";
import { WeeklyProvider } from "./weekly.js";
import type { OAuthUsageResponse } from "../utils/oauth.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const window = (percentUsed: number, resetAt: Date) => ({
  percentUsed,
  resetAt,
  isOverLimit: false,
});

const weeklyUsage = (
  sevenDay: OAuthUsageResponse["sevenDay"],
  models: Partial<Pick<OAuthUsageResponse, "sevenDayOpus" | "sevenDaySonnet">> = {}
): OAuthUsageResponse => ({
  fiveHour: null,
  sevenDay,
  sevenDayOpus: models.sevenDayOpus ?? null,
  sevenDaySonnet: models.sevenDaySonnet ?? null,
});

describe("WeeklyProvider", () => {
  let provider: WeeklyProvider;

  beforeEach(() => {
    provider = new WeeklyProvider();
  });

  describe("getWeeklyInfo", () => {
    it("returns realtime weekly info when usage has a seven-day window", () => {
      const futureDate = new Date(Date.now() + 5 * DAY_MS); // 5 days from now

      const result = provider.getWeeklyInfo(weeklyUsage(window(65, futureDate)));

      expect(result.percentUsed).toBe(65);
      expect(result.isRealtime).toBe(true);
      expect(result.resetAt).toEqual(futureDate);
      expect(result.weekProgressPercent).toBeGreaterThanOrEqual(0);
      expect(result.weekProgressPercent).toBeLessThanOrEqual(100);
      expect(result.opusPercentUsed).toBeNull();
      expect(result.sonnetPercentUsed).toBeNull();
    });

    it("returns null values and calculated week progress when usage has no sevenDay data", () => {
      const result = provider.getWeeklyInfo({
        fiveHour: window(25, new Date()),
        sevenDay: null,
        sevenDayOpus: null,
        sevenDaySonnet: null,
      });

      expect(result.percentUsed).toBeNull();
      expect(result.resetAt).toBeNull();
      expect(result.isRealtime).toBe(false);
      expect(result.weekProgressPercent).toBeGreaterThanOrEqual(0);
      expect(result.weekProgressPercent).toBeLessThanOrEqual(100);
    });

    it("returns model-specific usage when Opus data is available", () => {
      const futureDate = new Date(Date.now() + 5 * DAY_MS);

      const result = provider.getWeeklyInfo(
        weeklyUsage(window(47, futureDate), { sevenDayOpus: window(15, futureDate) })
      );

      expect(result.percentUsed).toBe(47);
      expect(result.opusPercentUsed).toBe(15);
      expect(result.sonnetPercentUsed).toBeNull();
      expect(result.opusResetAt).toEqual(futureDate);
      expect(result.sonnetResetAt).toBeNull();
    });

    it("returns model-specific usage when Sonnet data is available", () => {
      const futureDate = new Date(Date.now() + 5 * DAY_MS);

      const result = provider.getWeeklyInfo(
        weeklyUsage(window(47, futureDate), { sevenDaySonnet: window(7, futureDate) })
      );

      expect(result.percentUsed).toBe(47);
      expect(result.opusPercentUsed).toBeNull();
      expect(result.sonnetPercentUsed).toBe(7);
      expect(result.opusResetAt).toBeNull();
      expect(result.sonnetResetAt).toEqual(futureDate);
    });

    it("returns all model-specific usage when both are available", () => {
      const futureDate = new Date(Date.now() + 5 * DAY_MS);

      const result = provider.getWeeklyInfo(
        weeklyUsage(window(47, futureDate), {
          sevenDayOpus: window(15, futureDate),
          sevenDaySonnet: window(7, futureDate),
        })
      );

      expect(result.percentUsed).toBe(47);
      expect(result.opusPercentUsed).toBe(15);
      expect(result.sonnetPercentUsed).toBe(7);
    });

    it("returns null values when there is no usage", () => {
      const result = provider.getWeeklyInfo(null);

      expect(result.percentUsed).toBeNull();
      expect(result.isRealtime).toBe(false);
    });

    it("calculates week progress from the window's reset time", () => {
      // Reset time 2 days from now means we're 5 days into the week (71%)
      const twoDaysFromNow = new Date(Date.now() + 2 * DAY_MS);

      const result = provider.getWeeklyInfo(weeklyUsage(window(50, twoDaysFromNow)));

      // Should be around 71% (5/7 days)
      expect(result.weekProgressPercent).toBeGreaterThan(60);
      expect(result.weekProgressPercent).toBeLessThan(80);
    });

    it("measures week progress from the latest reset when the reset passed over a week ago", () => {
      // 10 days past the reset is 3 days into the following week (43%)
      const tenDaysAgo = new Date(Date.now() - 10 * DAY_MS);

      const result = provider.getWeeklyInfo(weeklyUsage(window(0, tenDaysAgo)));

      expect(result.weekProgressPercent).toBe(43);
    });
  });

  describe("week progress calculation (fallback mode)", () => {
    it("calculates progress with default Monday reset", () => {
      const result = provider.getWeeklyInfo(null);

      expect(result.weekProgressPercent).toBeGreaterThanOrEqual(0);
      expect(result.weekProgressPercent).toBeLessThanOrEqual(100);
    });

    it("accepts custom reset day", () => {
      // Reset on Sunday (0)
      const result = provider.getWeeklyInfo(null, 0);

      expect(result.weekProgressPercent).toBeGreaterThanOrEqual(0);
      expect(result.weekProgressPercent).toBeLessThanOrEqual(100);
    });

    it("accepts custom reset hour and minute", () => {
      const result = provider.getWeeklyInfo(null, 1, 12, 30); // Monday at 12:30

      expect(result.weekProgressPercent).toBeGreaterThanOrEqual(0);
      expect(result.weekProgressPercent).toBeLessThanOrEqual(100);
    });
  });
});
