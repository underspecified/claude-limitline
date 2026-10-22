import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveUsage, usageFromRateLimits, type UsageRequest } from "./usage.js";
import type { RateLimits } from "./claude-hook.js";
import { Renderer } from "../renderer.js";
import { DEFAULT_CONFIG } from "../config/index.js";
import { BlockProvider } from "../segments/block.js";
import { WeeklyProvider } from "../segments/weekly.js";
import type { EnvironmentInfo } from "./environment.js";

// The OAuth path is mocked; the usage-window construction stays real.
vi.mock("./oauth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./oauth.js")>()),
  getRealtimeUsage: vi.fn(),
  isLimitlineAuthFailing: vi.fn(),
  getUsageTrend: vi.fn(),
}));

vi.mock("./terminal.js", () => ({
  getTerminalWidth: vi.fn(() => 120),
}));

import { getRealtimeUsage, isLimitlineAuthFailing, getUsageTrend } from "./oauth.js";

const NOW = Date.now();
const inHours = (h: number) => Math.round(NOW / 1000) + h * 3600;
const window = (percentUsed: number) => ({
  percentUsed,
  resetAt: new Date(NOW + 24 * 3600_000),
  isOverLimit: false,
});

const REQUEST: UsageRequest = { pollInterval: 15, showTrend: true, fiveHour: true, sevenDay: true };
const ENV: EnvironmentInfo = {
  directory: "proj",
  hostname: null,
  gitBranch: null,
  gitDirty: false,
  model: "Opus",
  contextPercent: 0,
};

const BOTH: RateLimits = {
  five_hour: { used_percentage: 37, resets_at: inHours(2) },
  seven_day: { used_percentage: 64, resets_at: inHours(72) },
};
const FIVE_HOUR_ONLY: RateLimits = { five_hour: BOTH.five_hour };

async function render(rateLimits: RateLimits | null | undefined): Promise<string> {
  const { usage, trendInfo, authFailing } = await resolveUsage(rateLimits, REQUEST, NOW);
  return new Renderer(DEFAULT_CONFIG).render(
    new BlockProvider().getBlockInfo(usage),
    new WeeklyProvider().getWeeklyInfo(usage),
    ENV,
    trendInfo,
    authFailing
  );
}

const authCount = (output: string) => output.match(/auth!/g)?.length ?? 0;

describe("resolveUsage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // A dead limitline credential: refreshes failing for over a day, no usage.
    vi.mocked(isLimitlineAuthFailing).mockReturnValue(true);
    vi.mocked(getRealtimeUsage).mockResolvedValue(null);
    vi.mocked(getUsageTrend).mockReturnValue({
      fiveHourTrend: "up",
      sevenDayTrend: "up",
      sevenDayOpusTrend: "up",
      sevenDaySonnetTrend: "up",
    });
  });

  describe("with a dead credential", () => {
    it("renders both windows from stdin with no fallback request and no auth!", async () => {
      const output = await render(BOTH);

      expect(output).toContain("37%");
      expect(output).toContain("64%");
      expect(authCount(output)).toBe(0);
      expect(getRealtimeUsage).not.toHaveBeenCalled();
      expect(isLimitlineAuthFailing).not.toHaveBeenCalled();
    });

    it("shows auth! only on the window that fell back", async () => {
      const output = await render(FIVE_HOUR_ONLY);

      expect(output).toContain("37%");
      expect(authCount(output)).toBe(1);
      expect(getRealtimeUsage).toHaveBeenCalledWith(15);
    });

    it("shows auth! on both windows without stdin rate_limits", async () => {
      const output = await render(undefined);

      expect(authCount(output)).toBe(2);
      expect(getRealtimeUsage).toHaveBeenCalledWith(15);
    });

    it("treats rate_limits: null (an API-key session) like no stdin", async () => {
      const output = await render(null);

      expect(authCount(output)).toBe(2);
    });

    it("falls back for a malformed window and keeps the valid one", async () => {
      const output = await render({
        five_hour: BOTH.five_hour,
        seven_day: { used_percentage: 64 }, // no resets_at
      });

      expect(output).toContain("37%");
      expect(authCount(output)).toBe(1);
    });
  });

  it("fills only the missing window from a working fallback", async () => {
    vi.mocked(getRealtimeUsage).mockResolvedValue({
      fiveHour: window(99),
      sevenDay: window(55),
      sevenDayOpus: null,
      sevenDaySonnet: null,
    });

    const { usage } = await resolveUsage(FIVE_HOUR_ONLY, REQUEST, NOW);

    expect(usage?.fiveHour?.percentUsed).toBe(37);
    expect(usage?.sevenDay?.percentUsed).toBe(55);
  });

  it("keeps per-model windows only when the weekly window fell back", async () => {
    vi.mocked(getRealtimeUsage).mockResolvedValue({
      fiveHour: window(99),
      sevenDay: window(55),
      sevenDayOpus: window(15),
      sevenDaySonnet: window(7),
    });

    const stdinWeekly = await resolveUsage(
      { seven_day: BOTH.seven_day },
      REQUEST,
      NOW
    );
    const apiWeekly = await resolveUsage(FIVE_HOUR_ONLY, REQUEST, NOW);

    expect(stdinWeekly.usage?.sevenDaySonnet).toBeNull();
    expect(apiWeekly.usage?.sevenDaySonnet?.percentUsed).toBe(7);
  });

  it("keeps trend arrows only on windows that fell back", async () => {
    const { trendInfo } = await resolveUsage(FIVE_HOUR_ONLY, REQUEST, NOW);

    expect(trendInfo?.fiveHourTrend).toBeNull();
    expect(trendInfo?.sevenDayTrend).toBe("up");
  });

  it("has no trend arrows when both windows come from stdin", async () => {
    const { trendInfo } = await resolveUsage(BOTH, REQUEST, NOW);

    expect(trendInfo).toBeNull();
    expect(getUsageTrend).not.toHaveBeenCalled();
  });

  it("doesn't fetch for a disabled segment's missing window", async () => {
    await resolveUsage(FIVE_HOUR_ONLY, { ...REQUEST, sevenDay: false }, NOW);

    expect(getRealtimeUsage).not.toHaveBeenCalled();
  });

  it("shows no fallback usage when the fallback throws", async () => {
    vi.mocked(getRealtimeUsage).mockRejectedValue(new Error("Network error"));

    const { usage } = await resolveUsage(FIVE_HOUR_ONLY, REQUEST, NOW);

    expect(usage?.fiveHour?.percentUsed).toBe(37);
    expect(usage?.sevenDay).toBeNull();
  });
});

describe("usageFromRateLimits", () => {
  const NOW = 1_800_000_000_000; // epoch ms
  const inHours = (h: number) => NOW / 1000 + h * 3600; // epoch seconds

  it("converts both windows, reading resets_at as epoch seconds", () => {
    const usage = usageFromRateLimits(
      {
        five_hour: { used_percentage: 42, resets_at: inHours(2) },
        seven_day: { used_percentage: 100, resets_at: inHours(72) },
      },
      NOW
    );

    expect(usage.fiveHour).toEqual({
      percentUsed: 42,
      resetAt: new Date(NOW + 2 * 3600_000),
      isOverLimit: false,
    });
    expect(usage.sevenDay).toEqual({
      percentUsed: 100,
      resetAt: new Date(NOW + 72 * 3600_000),
      isOverLimit: true,
    });
  });

  it("keeps a window null when stdin omits it", () => {
    const usage = usageFromRateLimits(
      { five_hour: { used_percentage: 5, resets_at: inHours(1) } },
      NOW
    );

    expect(usage.fiveHour?.percentUsed).toBe(5);
    expect(usage.sevenDay).toBeNull();
  });

  it("has no windows without rate_limits, or with rate_limits: null (an API-key session)", () => {
    expect(usageFromRateLimits(undefined, NOW)).toEqual({ fiveHour: null, sevenDay: null });
    expect(usageFromRateLimits(null, NOW)).toEqual({ fiveHour: null, sevenDay: null });
  });

  it.each([
    ["a string percentage", { used_percentage: "42", resets_at: inHours(1) }],
    ["a string resets_at", { used_percentage: 42, resets_at: String(inHours(1)) }],
    ["a missing resets_at", { used_percentage: 42 }],
    ["a missing used_percentage", { resets_at: inHours(1) }],
    ["an infinite percentage (1e999)", { used_percentage: Infinity, resets_at: inHours(1) }],
    ["a NaN percentage", { used_percentage: NaN, resets_at: inHours(1) }],
    ["an infinite resets_at", { used_percentage: 42, resets_at: Infinity }],
    ["a -Infinity resets_at", { used_percentage: 42, resets_at: -Infinity }],
    ["resets_at in milliseconds", { used_percentage: 42, resets_at: inHours(1) * 1000 }],
    ["resets_at more than 8 days out", { used_percentage: 42, resets_at: inHours(8 * 24 + 1) }],
    ["an infinite percentage on a passed window", { used_percentage: Infinity, resets_at: inHours(-1) }],
  ])("rejects a window with %s, so it falls back", (_label, window) => {
    const usage = usageFromRateLimits(
      { five_hour: window as never, seven_day: window as never },
      NOW
    );

    expect(usage).toEqual({ fiveHour: null, sevenDay: null });
  });

  it("clamps the percentage to 0-100", () => {
    const usage = usageFromRateLimits(
      {
        five_hour: { used_percentage: -5, resets_at: inHours(1) },
        seven_day: { used_percentage: 105, resets_at: inHours(24) },
      },
      NOW
    );

    expect(usage.fiveHour?.percentUsed).toBe(0);
    expect(usage.sevenDay?.percentUsed).toBe(100);
    expect(usage.sevenDay?.isOverLimit).toBe(true);
  });

  it("treats a window whose resets_at has passed as rolled over, at 0%", () => {
    const usage = usageFromRateLimits(
      { five_hour: { used_percentage: 95, resets_at: inHours(-1) } },
      NOW
    );

    expect(usage.fiveHour).toEqual({
      percentUsed: 0,
      resetAt: new Date(NOW - 3600_000),
      isOverLimit: false,
    });
  });

  it("keeps a valid window when the other is malformed", () => {
    const usage = usageFromRateLimits(
      {
        five_hour: { used_percentage: 37, resets_at: inHours(2) },
        seven_day: { used_percentage: 64 },
      },
      NOW
    );

    expect(usage.fiveHour?.percentUsed).toBe(37);
    expect(usage.sevenDay).toBeNull();
  });
});
