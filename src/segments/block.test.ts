import { describe, it, expect, beforeEach } from "vitest";
import { BlockProvider } from "./block.js";
import type { OAuthUsageResponse } from "../utils/oauth.js";

const withFiveHour = (
  fiveHour: OAuthUsageResponse["fiveHour"]
): OAuthUsageResponse => ({
  fiveHour,
  sevenDay: null,
  sevenDayOpus: null,
  sevenDaySonnet: null,
});

describe("BlockProvider", () => {
  let provider: BlockProvider;

  beforeEach(() => {
    provider = new BlockProvider();
  });

  describe("getBlockInfo", () => {
    it("returns realtime block info when usage has a five-hour window", () => {
      const futureDate = new Date(Date.now() + 3 * 60 * 60 * 1000); // 3 hours from now

      const result = provider.getBlockInfo(
        withFiveHour({ percentUsed: 45, resetAt: futureDate, isOverLimit: false })
      );

      expect(result.percentUsed).toBe(45);
      expect(result.isRealtime).toBe(true);
      expect(result.timeRemaining).toBeGreaterThan(0);
      expect(result.resetAt).toEqual(futureDate);
    });

    it("calculates correct time remaining", () => {
      const twoHoursFromNow = new Date(Date.now() + 2 * 60 * 60 * 1000);

      const result = provider.getBlockInfo(
        withFiveHour({ percentUsed: 30, resetAt: twoHoursFromNow, isOverLimit: false })
      );

      // Should be approximately 120 minutes (2 hours)
      expect(result.timeRemaining).toBeGreaterThanOrEqual(119);
      expect(result.timeRemaining).toBeLessThanOrEqual(121);
    });

    it("returns null values when usage has no fiveHour data", () => {
      const result = provider.getBlockInfo({
        fiveHour: null,
        sevenDay: { percentUsed: 50, resetAt: new Date(), isOverLimit: false },
        sevenDayOpus: null,
        sevenDaySonnet: null,
      });

      expect(result.percentUsed).toBeNull();
      expect(result.resetAt).toBeNull();
      expect(result.timeRemaining).toBeNull();
      expect(result.isRealtime).toBe(false);
    });

    it("returns null values when there is no usage", () => {
      const result = provider.getBlockInfo(null);

      expect(result.percentUsed).toBeNull();
      expect(result.resetAt).toBeNull();
      expect(result.timeRemaining).toBeNull();
      expect(result.isRealtime).toBe(false);
    });

    it("handles zero time remaining when reset time is past", () => {
      const pastDate = new Date(Date.now() - 1000); // 1 second ago

      const result = provider.getBlockInfo(
        withFiveHour({ percentUsed: 100, resetAt: pastDate, isOverLimit: true })
      );

      expect(result.timeRemaining).toBe(0);
    });
  });
});
