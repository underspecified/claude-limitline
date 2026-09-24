import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchUsageFromAPI,
  getUsageTrend,
  getRealtimeUsage,
  clearUsageCache,
  getOAuthToken,
  getOAuthCredential,
  parseRetryAfter,
  OAUTH_TOKEN_URL,
  refreshBackoffMs,
  isLimitlineAuthFailing,
} from "./oauth.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock fs and child_process
vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
}));

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

import fs from "node:fs";
import { exec } from "node:child_process";

describe("oauth utilities", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearUsageCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("fetchUsageFromAPI", () => {
    it("returns parsed usage data on success", async () => {
      const mockResponse = {
        five_hour: {
          resets_at: "2025-01-15T12:00:00Z",
          utilization: 45.5,
        },
        seven_day: {
          resets_at: "2025-01-20T00:00:00Z",
          utilization: 30.2,
        },
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await fetchUsageFromAPI("test-token");

      expect(result.usage).not.toBeNull();
      expect(result.usage?.fiveHour?.percentUsed).toBe(45.5);
      expect(result.usage?.sevenDay?.percentUsed).toBe(30.2);
      expect(result.usage?.fiveHour?.isOverLimit).toBe(false);
    });

    it("sets isOverLimit to true when utilization >= 100", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            five_hour: { utilization: 100 },
            seven_day: { utilization: 150 },
          }),
      });

      const result = await fetchUsageFromAPI("test-token");

      expect(result.usage?.fiveHour?.isOverLimit).toBe(true);
      expect(result.usage?.sevenDay?.isOverLimit).toBe(true);
    });

    it("returns null when API returns error status", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      });

      const result = await fetchUsageFromAPI("invalid-token");

      expect(result.usage).toBeNull();
      expect(result.status).toBe(401);
    });

    it("returns null when fetch throws", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      const result = await fetchUsageFromAPI("test-token");

      expect(result.usage).toBeNull();
    });

    it("captures Retry-After (delta-seconds) on 429", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: { get: (h: string) => (h.toLowerCase() === "retry-after" ? "120" : null) },
      });

      const result = await fetchUsageFromAPI("test-token");

      expect(result.usage).toBeNull();
      expect(result.status).toBe(429);
      expect(result.retryAfterMs).toBe(120_000);
    });

    it("leaves retryAfterMs null when no Retry-After header", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        headers: { get: () => null },
      });

      const result = await fetchUsageFromAPI("test-token");

      expect(result.retryAfterMs).toBeNull();
    });

    it("handles missing five_hour data", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            seven_day: { utilization: 50 },
          }),
      });

      const result = await fetchUsageFromAPI("test-token");

      expect(result.usage?.fiveHour).toBeNull();
      expect(result.usage?.sevenDay?.percentUsed).toBe(50);
    });

    it("handles missing seven_day data", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            five_hour: { utilization: 25 },
          }),
      });

      const result = await fetchUsageFromAPI("test-token");

      expect(result.usage?.fiveHour?.percentUsed).toBe(25);
      expect(result.usage?.sevenDay).toBeNull();
    });

    it("parses seven_day_opus when present", async () => {
      const mockResponse = {
        five_hour: { utilization: 29.0, resets_at: "2025-01-15T12:00:00Z" },
        seven_day: { utilization: 47.0, resets_at: "2025-01-20T00:00:00Z" },
        seven_day_opus: { utilization: 15.0, resets_at: "2025-01-20T00:00:00Z" },
        seven_day_sonnet: null,
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await fetchUsageFromAPI("test-token");

      expect(result.usage?.sevenDayOpus?.percentUsed).toBe(15.0);
      expect(result.usage?.sevenDaySonnet).toBeNull();
    });

    it("parses seven_day_sonnet when present", async () => {
      const mockResponse = {
        five_hour: { utilization: 29.0, resets_at: "2025-01-15T12:00:00Z" },
        seven_day: { utilization: 47.0, resets_at: "2025-01-20T00:00:00Z" },
        seven_day_opus: null,
        seven_day_sonnet: { utilization: 7.0, resets_at: "2025-01-20T00:00:00Z" },
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await fetchUsageFromAPI("test-token");

      expect(result.usage?.sevenDayOpus).toBeNull();
      expect(result.usage?.sevenDaySonnet?.percentUsed).toBe(7.0);
    });

    it("parses all model-specific limits when present", async () => {
      const mockResponse = {
        five_hour: { utilization: 29.0, resets_at: "2025-01-15T12:00:00Z" },
        seven_day: { utilization: 47.0, resets_at: "2025-01-20T00:00:00Z" },
        seven_day_opus: { utilization: 15.0, resets_at: "2025-01-20T00:00:00Z" },
        seven_day_sonnet: { utilization: 7.0, resets_at: "2025-01-20T00:00:00Z" },
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await fetchUsageFromAPI("test-token");

      expect(result.usage?.sevenDay?.percentUsed).toBe(47.0);
      expect(result.usage?.sevenDayOpus?.percentUsed).toBe(15.0);
      expect(result.usage?.sevenDaySonnet?.percentUsed).toBe(7.0);
    });

    it("sends correct headers", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });

      await fetchUsageFromAPI("my-token");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.anthropic.com/api/oauth/usage",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            Authorization: "Bearer my-token",
            "anthropic-beta": "oauth-2025-04-20",
          }),
        })
      );
    });
  });

  describe("getUsageTrend", () => {
    it("returns null trends when no cached data", () => {
      clearUsageCache();
      const trend = getUsageTrend();

      expect(trend.fiveHourTrend).toBeNull();
      expect(trend.sevenDayTrend).toBeNull();
      expect(trend.sevenDayOpusTrend).toBeNull();
      expect(trend.sevenDaySonnetTrend).toBeNull();
    });

    // Note: Testing trends with actual API calls requires integration tests
    // The trend comparison depends on module-level state (cachedUsage, previousUsage)
    // that persists between calls. The getRealtimeUsage function also calls
    // platform-specific code that is difficult to mock without complex setup.
  });

  describe("clearUsageCache", () => {
    it("is a function that can be called", () => {
      // clearUsageCache resets internal module state
      // We can't easily test the effect without integration tests
      expect(() => clearUsageCache()).not.toThrow();
    });
  });

  describe("getOAuthToken", () => {
    it("returns null for unsupported platform", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "freebsd" });

      const token = await getOAuthToken();

      expect(token).toBeNull();

      Object.defineProperty(process, "platform", { value: originalPlatform });
    });

    describe("macOS", () => {
      const originalPlatform = process.platform;

      beforeEach(() => {
        Object.defineProperty(process, "platform", { value: "darwin" });
      });

      afterEach(() => {
        Object.defineProperty(process, "platform", { value: originalPlatform });
      });

      it("parses JSON credentials from keychain with claudeAiOauth structure", async () => {
        const mockCredentials = JSON.stringify({
          claudeAiOauth: {
            accessToken: "sk-ant-oat-test-token-12345",
          },
        });

        vi.mocked(exec).mockImplementation(((cmd: string, opts: unknown, callback?: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
          // Handle both (cmd, callback) and (cmd, opts, callback) signatures
          const cb = typeof opts === "function" ? opts : callback;
          if (cb) {
            cb(null, { stdout: mockCredentials, stderr: "" });
          }
          return {} as ReturnType<typeof exec>;
        }) as typeof exec);

        const token = await getOAuthToken();

        expect(token).toBe("sk-ant-oat-test-token-12345");
      });

      it("falls back to raw token if keychain returns non-JSON", async () => {
        const rawToken = "sk-ant-oat-raw-token-67890";

        vi.mocked(exec).mockImplementation(((cmd: string, opts: unknown, callback?: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
          const cb = typeof opts === "function" ? opts : callback;
          if (cb) {
            cb(null, { stdout: rawToken, stderr: "" });
          }
          return {} as ReturnType<typeof exec>;
        }) as typeof exec);

        const token = await getOAuthToken();

        expect(token).toBe("sk-ant-oat-raw-token-67890");
      });

      it("returns null when keychain retrieval fails", async () => {
        vi.mocked(exec).mockImplementation(((cmd: string, opts: unknown, callback?: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
          const cb = typeof opts === "function" ? opts : callback;
          if (cb) {
            cb(new Error("keychain error"), { stdout: "", stderr: "" });
          }
          return {} as ReturnType<typeof exec>;
        }) as typeof exec);

        const token = await getOAuthToken();

        expect(token).toBeNull();
      });

      it("returns null when JSON is valid but missing accessToken", async () => {
        const mockCredentials = JSON.stringify({
          claudeAiOauth: {
            refreshToken: "some-refresh-token",
          },
        });

        vi.mocked(exec).mockImplementation(((cmd: string, opts: unknown, callback?: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
          const cb = typeof opts === "function" ? opts : callback;
          if (cb) {
            cb(null, { stdout: mockCredentials, stderr: "" });
          }
          return {} as ReturnType<typeof exec>;
        }) as typeof exec);

        const token = await getOAuthToken();

        expect(token).toBeNull();
      });

      it("returns null when token doesn't start with sk-ant-oat", async () => {
        const mockCredentials = JSON.stringify({
          claudeAiOauth: {
            accessToken: "invalid-token-format",
          },
        });

        vi.mocked(exec).mockImplementation(((cmd: string, opts: unknown, callback?: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
          const cb = typeof opts === "function" ? opts : callback;
          if (cb) {
            cb(null, { stdout: mockCredentials, stderr: "" });
          }
          return {} as ReturnType<typeof exec>;
        }) as typeof exec);

        const token = await getOAuthToken();

        expect(token).toBeNull();
      });

      it("uses correct keychain service name", async () => {
        vi.mocked(exec).mockImplementation(((cmd: string, opts: unknown, callback?: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
          const cb = typeof opts === "function" ? opts : callback;
          if (cb) {
            cb(new Error("not found"), { stdout: "", stderr: "" });
          }
          return {} as ReturnType<typeof exec>;
        }) as typeof exec);

        await getOAuthToken();

        expect(exec).toHaveBeenCalledWith(
          expect.stringContaining("Claude Code-credentials"),
          expect.anything(),
          expect.anything()
        );
      });
    });
  });

  // Helper: drive the mocked exec by branching on the command string, so a
  // single getOAuthCredential() call can see different keychain items per query.
  const mockExecByCommand = (
    resolve: (cmd: string) => string | Error
  ): void => {
    vi.mocked(exec).mockImplementation(((
      cmd: string,
      opts: unknown,
      callback?: (
        error: Error | null,
        result: { stdout: string; stderr: string }
      ) => void
    ) => {
      const cb = typeof opts === "function" ? opts : callback;
      const out = resolve(cmd);
      if (cb) {
        if (out instanceof Error) cb(out, { stdout: "", stderr: "" });
        else cb(null, { stdout: out, stderr: "" });
      }
      return {} as ReturnType<typeof exec>;
    }) as typeof exec);
  };

  const credJson = (accessToken: string, expiresAt: number): string =>
    JSON.stringify({ claudeAiOauth: { accessToken, expiresAt } });

  describe("getOAuthCredential macOS account preference", () => {
    const originalPlatform = process.platform;

    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "darwin" });
    });

    afterEach(() => {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    });

    it("prefers the current-user account item over a service-only orphan", async () => {
      const fresh = "sk-ant-oat-fresh-user-item";
      const orphan = "sk-ant-oat-orphan-item";
      // The username-scoped query carries `-a "..."`; the fallback does not.
      mockExecByCommand((cmd) =>
        cmd.includes('-a "')
          ? credJson(fresh, Date.now() + 3_600_000)
          : credJson(orphan, Date.now() - 99_999_999)
      );

      const cred = await getOAuthCredential();

      expect(cred?.token).toBe(fresh);
      expect(cred?.expiresAt).toBeGreaterThan(Date.now());
    });

    it("falls back to the service-only lookup when the account query fails", async () => {
      const orphan = "sk-ant-oat-service-only-item";
      mockExecByCommand((cmd) =>
        cmd.includes('-a "')
          ? new Error("no item for that account")
          : credJson(orphan, Date.now() + 3_600_000)
      );

      const cred = await getOAuthCredential();

      expect(cred?.token).toBe(orphan);
    });

    it("surfaces the token's expiry from the keychain JSON", async () => {
      const exp = Date.now() + 1_234_000;
      mockExecByCommand(() => credJson("sk-ant-oat-x", exp));

      const cred = await getOAuthCredential();

      expect(cred?.expiresAt).toBe(exp);
    });
  });

  describe("getRealtimeUsage expiry guard (macOS)", () => {
    const originalPlatform = process.platform;

    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      vi.mocked(fs.existsSync).mockReturnValue(false); // no disk cache
    });

    afterEach(() => {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    });

    it("does NOT call the API or arm a cool-off when the keychain token is expired", async () => {
      mockExecByCommand(() => credJson("sk-ant-oat-expired", Date.now() - 60_000));

      const result = await getRealtimeUsage(15);

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled(); // no 429 to weaponize
      expect(fs.writeFileSync).not.toHaveBeenCalled(); // no retryUntil written
    });

    it("DOES call the API when the keychain token is still valid", async () => {
      mockExecByCommand(() => credJson("sk-ant-oat-valid", Date.now() + 3_600_000));
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            five_hour: { resets_at: "2026-01-15T12:00:00Z", utilization: 10 },
            seven_day: { resets_at: "2026-01-20T00:00:00Z", utilization: 20 },
          }),
      });

      const result = await getRealtimeUsage(15);

      expect(mockFetch).toHaveBeenCalledOnce();
      expect(result?.fiveHour?.percentUsed).toBe(10);
    });
  });

  describe("parseRetryAfter", () => {
    it("parses delta-seconds into milliseconds", () => {
      expect(parseRetryAfter("120")).toBe(120_000);
      expect(parseRetryAfter("0")).toBe(0);
    });

    it("returns null for a missing or unparseable header", () => {
      expect(parseRetryAfter(null)).toBeNull();
      expect(parseRetryAfter("not-a-date")).toBeNull();
    });

    it("parses an HTTP-date into a non-negative delay", () => {
      const future = new Date(Date.now() + 60_000).toUTCString();
      const ms = parseRetryAfter(future);
      expect(ms).not.toBeNull();
      expect(ms as number).toBeGreaterThan(0);
    });
  });

  describe("limitline self-refreshing credential", () => {
    const CREDS = "claude-limitline-credentials.json";
    const originalPlatform = process.platform;

    // Point fs at a limitline-creds file (and nothing else) so these tests
    // isolate the limitline-credential path; the disk cache reads as absent.
    const setCreds = (creds: object | null) => {
      vi.mocked(fs.existsSync).mockImplementation((p) =>
        String(p).includes(CREDS) ? creds !== null : false
      );
      vi.mocked(fs.readFileSync).mockImplementation((p) =>
        String(p).includes(CREDS) && creds ? JSON.stringify(creds) : "{}"
      );
    };

    const usageOk = {
      ok: true,
      json: () =>
        Promise.resolve({
          five_hour: { resets_at: "2026-01-15T12:00:00Z", utilization: 26 },
          seven_day: { resets_at: "2026-01-20T00:00:00Z", utilization: 32 },
        }),
    };

    beforeEach(() => {
      // Unsupported platform => the keychain fallback deterministically yields
      // null, so only the limitline-credential path can produce a token.
      Object.defineProperty(process, "platform", { value: "freebsd" });
    });

    afterEach(() => {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    });

    it("uses a valid limitline credential without refreshing", async () => {
      setCreds({
        accessToken: "sk-ant-oat-valid",
        refreshToken: "sk-ant-ort-x",
        expiresAt: Date.now() + 3_600_000,
      });
      mockFetch.mockImplementation((url) => {
        if (String(url).includes("oauth/usage")) return Promise.resolve(usageOk);
        throw new Error(`must not hit the token endpoint: ${url}`);
      });

      const result = await getRealtimeUsage(15);

      expect(result?.fiveHour?.percentUsed).toBe(26);
      expect(mockFetch).toHaveBeenCalledOnce(); // usage only, no refresh
      expect(fs.writeFileSync).not.toHaveBeenCalledWith(
        expect.stringContaining(CREDS),
        expect.anything(),
        expect.anything()
      );
    });

    it("refreshes an expired credential, persists the rotated token, then fetches usage", async () => {
      setCreds({
        accessToken: "sk-ant-oat-old",
        refreshToken: "sk-ant-ort-old",
        expiresAt: Date.now() - 1000,
      });
      mockFetch.mockImplementation((url) => {
        if (String(url).includes("oauth/token")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                access_token: "sk-ant-oat-new",
                refresh_token: "sk-ant-ort-new",
                expires_in: 28800,
                scope: "user:inference user:profile",
              }),
          });
        }
        if (String(url).includes("oauth/usage")) return Promise.resolve(usageOk);
        throw new Error(`unexpected fetch: ${url}`);
      });

      const result = await getRealtimeUsage(15);

      expect(result?.sevenDay?.percentUsed).toBe(32);
      const wrote = vi
        .mocked(fs.writeFileSync)
        .mock.calls.find((c) => String(c[0]).includes(CREDS));
      expect(wrote).toBeTruthy();
      expect(String(wrote?.[1])).toContain("sk-ant-ort-new"); // rotated token persisted
    });

    it("does not hit the token endpoint while a refresh backoff is active", async () => {
      setCreds({
        accessToken: "sk-ant-oat-old",
        refreshToken: "sk-ant-ort-old",
        expiresAt: Date.now() - 1000,
        refreshFailUntil: Date.now() + 5 * 60_000,
      });
      mockFetch.mockImplementation((url) => {
        throw new Error(`should not fetch during backoff: ${url}`);
      });

      const result = await getRealtimeUsage(15);

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("records a backoff and makes no usage call when the refresh fails", async () => {
      setCreds({
        accessToken: "sk-ant-oat-old",
        refreshToken: "sk-ant-ort-old",
        expiresAt: Date.now() - 1000,
      });
      mockFetch.mockImplementation((url) => {
        if (String(url).includes("oauth/token"))
          return Promise.resolve({ ok: false, status: 429 });
        throw new Error(`usage must not be called when refresh fails: ${url}`);
      });

      const result = await getRealtimeUsage(15);

      expect(result).toBeNull();
      const wrote = vi
        .mocked(fs.writeFileSync)
        .mock.calls.find((c) => String(c[0]).includes(CREDS));
      expect(wrote).toBeTruthy();
      expect(String(wrote?.[1])).toContain("refreshFailUntil");
    });

    it("refreshes against Claude Code's current token endpoint, with scope", async () => {
      setCreds({
        accessToken: "sk-ant-oat-old",
        refreshToken: "sk-ant-ort-old",
        expiresAt: Date.now() - 1000,
        scopes: "user:profile user:inference",
      });
      mockFetch.mockResolvedValue({ ok: false, status: 400 });

      await getRealtimeUsage(15);

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://platform.claude.com/v1/oauth/token");
      expect(JSON.parse(init.body)).toMatchObject({
        grant_type: "refresh_token",
        client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        scope: "user:profile user:inference",
      });
    });

    const credsWrite = () =>
      JSON.parse(
        String(
          vi.mocked(fs.writeFileSync).mock.calls.find((c) => String(c[0]).includes(CREDS))?.[1]
        )
      );
    const failRefresh = () => mockFetch.mockResolvedValue({ ok: false, status: 400 });

    it("doubles the backoff per consecutive failure, capped at 24h", () => {
      expect(refreshBackoffMs(1)).toBe(10 * 60_000);
      expect(refreshBackoffMs(2)).toBe(20 * 60_000);
      expect(refreshBackoffMs(8)).toBe(1280 * 60_000);
      expect(refreshBackoffMs(9)).toBe(24 * 3_600_000);
      expect(refreshBackoffMs(5000)).toBe(24 * 3_600_000);
    });

    it("starts a streak from a legacy creds file with no failure fields", async () => {
      setCreds({
        accessToken: "a", refreshToken: "r", expiresAt: Date.now() - 1000,
        refreshFailUntil: Date.now() - 1,
      });
      failRefresh();
      await getRealtimeUsage(15);
      const w = credsWrite();
      expect(w.refreshFailures).toBe(1);
      expect(w.refreshFailUntil - w.refreshFailingSince).toBe(10 * 60_000);
    });

    it("counts consecutive failures and keeps the streak start", async () => {
      const since = Date.now() - 3 * 3_600_000;
      setCreds({
        accessToken: "a", refreshToken: "r", expiresAt: Date.now() - 1000,
        refreshFailures: 2, refreshFailingSince: since,
      });
      failRefresh();
      const before = Date.now();
      await getRealtimeUsage(15);
      const w = credsWrite();
      expect(w.refreshFailures).toBe(3);
      expect(w.refreshFailingSince).toBe(since);
      expect(w.refreshFailUntil).toBeGreaterThanOrEqual(before + 40 * 60_000);
      expect(w.refreshFailUntil).toBeLessThanOrEqual(Date.now() + 40 * 60_000);
    });

    it("clears the failure streak after a successful refresh", async () => {
      setCreds({
        accessToken: "a", refreshToken: "r", expiresAt: Date.now() - 1000,
        refreshFailures: 5, refreshFailingSince: Date.now() - 2 * 86_400_000,
      });
      mockFetch.mockImplementation((url) =>
        Promise.resolve(
          String(url).includes("oauth/token")
            ? { ok: true, json: () => Promise.resolve({ access_token: "n", refresh_token: "nr", expires_in: 28800 }) }
            : usageOk
        )
      );
      await getRealtimeUsage(15);
      const w = credsWrite();
      expect(w.refreshFailures).toBeUndefined();
      expect(w.refreshFailingSince).toBeUndefined();
      expect(w.refreshFailUntil).toBe(0);
    });

    describe("isLimitlineAuthFailing", () => {
      const H = 3_600_000;
      it("is false with no limitline credential file (keychain-only)", () => {
        setCreds(null);
        expect(isLimitlineAuthFailing()).toBe(false);
      });
      it("is false for a healthy credential", () => {
        setCreds({ accessToken: "a", refreshToken: "r", expiresAt: Date.now() + H });
        expect(isLimitlineAuthFailing()).toBe(false);
      });
      it("is false while the failure streak is under a day old", () => {
        setCreds({ accessToken: "a", refreshToken: "r", expiresAt: 0, refreshFailingSince: Date.now() - 23 * H });
        expect(isLimitlineAuthFailing()).toBe(false);
      });
      it("is true once refreshes have failed for a day", () => {
        setCreds({ accessToken: "a", refreshToken: "r", expiresAt: 0, refreshFailingSince: Date.now() - 25 * H });
        expect(isLimitlineAuthFailing()).toBe(true);
      });
    });
  });

  describe("OAuth endpoints", () => {
    it("limitline-auth.mjs uses the same current endpoints as the statusline", async () => {
      const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
      const src = realFs.readFileSync(
        new URL("../../limitline-auth.mjs", import.meta.url),
        "utf-8"
      );
      expect(OAUTH_TOKEN_URL).toBe("https://platform.claude.com/v1/oauth/token");
      expect(src).toContain(`TOKEN_URL = "${OAUTH_TOKEN_URL}"`);
      expect(src).toContain('AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize"');
      expect(src).toContain('REDIRECT_URI = "https://platform.claude.com/oauth/code/callback"');
      expect(src).not.toContain("console.anthropic.com");
    });
  });
});
