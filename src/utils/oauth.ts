import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { debug } from "./logger.js";

const execAsync = promisify(exec);

interface UsageData {
  resetAt: Date;
  percentUsed: number;
  isOverLimit: boolean;
}

export interface OAuthUsageResponse {
  fiveHour: UsageData | null;
  sevenDay: UsageData | null;
  sevenDayOpus: UsageData | null;
  sevenDaySonnet: UsageData | null;
  raw?: unknown;
}

interface ApiUsageBlock {
  resets_at?: string;
  utilization?: number;
}

interface ApiResponse {
  five_hour?: ApiUsageBlock;
  seven_day?: ApiUsageBlock;
  seven_day_opus?: ApiUsageBlock | null;
  seven_day_sonnet?: ApiUsageBlock | null;
}

async function getOAuthTokenWindows(): Promise<string | null> {
  try {
    // Try PowerShell to access Windows Credential Manager
    const { stdout } = await execAsync(
      `powershell -Command "[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String((Get-StoredCredential -Target 'Claude Code' -AsCredentialObject).Password))"`,
      { timeout: 5000 }
    );
    const token = stdout.trim();
    if (token && token.startsWith("sk-ant-oat")) {
      return token;
    }
  } catch (error) {
    debug("PowerShell credential retrieval failed:", error);
  }

  try {
    // Alternative: Try cmdkey approach
    const { stdout } = await execAsync(
      `powershell -Command "$cred = cmdkey /list:Claude* | Select-String -Pattern 'User:.*'; if ($cred) { $cred.Line.Split(':')[1].Trim() }"`,
      { timeout: 5000 }
    );
    debug("cmdkey output:", stdout);
  } catch (error) {
    debug("cmdkey approach failed:", error);
  }

  // Try looking in common Claude Code config locations
  // Primary location - Claude Code stores credentials in ~/.claude/.credentials.json
  const primaryPath = path.join(os.homedir(), ".claude", ".credentials.json");
  try {
    if (fs.existsSync(primaryPath)) {
      const content = fs.readFileSync(primaryPath, "utf-8");
      const config = JSON.parse(content);

      // Claude Code stores OAuth as an object with accessToken
      if (config.claudeAiOauth && typeof config.claudeAiOauth === "object") {
        const token = config.claudeAiOauth.accessToken;
        if (token && typeof token === "string" && token.startsWith("sk-ant-oat")) {
          debug(`Found OAuth token in ${primaryPath} under claudeAiOauth.accessToken`);
          return token;
        }
      }
    }
  } catch (error) {
    debug(`Failed to read config from ${primaryPath}:`, error);
  }

  // Fallback locations
  const fallbackPaths = [
    path.join(os.homedir(), ".claude", "credentials.json"),
    path.join(os.homedir(), ".config", "claude-code", "credentials.json"),
    path.join(process.env.APPDATA || "", "Claude Code", "credentials.json"),
    path.join(process.env.LOCALAPPDATA || "", "Claude Code", "credentials.json"),
  ];

  for (const configPath of fallbackPaths) {
    try {
      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, "utf-8");
        const config = JSON.parse(content);

        for (const key of ["oauth_token", "token", "accessToken"]) {
          const token = config[key];
          if (token && typeof token === "string" && token.startsWith("sk-ant-oat")) {
            debug(`Found OAuth token in ${configPath} under key ${key}`);
            return token;
          }
        }
      }
    } catch (error) {
      debug(`Failed to read config from ${configPath}:`, error);
    }
  }

  return null;
}

async function getOAuthTokenMacOS(): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      `security find-generic-password -s "Claude Code-credentials" -w`,
      { timeout: 5000 }
    );
    const content = stdout.trim();

    // The keychain stores JSON with structure: {"claudeAiOauth":{"accessToken":"..."}}
    if (content.startsWith("{")) {
      try {
        const parsed = JSON.parse(content);
        if (parsed.claudeAiOauth && typeof parsed.claudeAiOauth === "object") {
          const token = parsed.claudeAiOauth.accessToken;
          if (token && typeof token === "string" && token.startsWith("sk-ant-oat")) {
            debug("Found OAuth token in macOS Keychain under claudeAiOauth.accessToken");
            return token;
          }
        }
      } catch (parseError) {
        debug("Failed to parse keychain JSON:", parseError);
      }
    }

    // Fallback: check if it's a raw token
    if (content.startsWith("sk-ant-oat")) {
      return content;
    }
  } catch (error) {
    debug("macOS Keychain retrieval failed:", error);
  }

  return null;
}

async function getOAuthTokenLinux(): Promise<string | null> {
  // Try secret-tool (GNOME Keyring)
  try {
    const { stdout } = await execAsync(
      `secret-tool lookup service "Claude Code"`,
      { timeout: 5000 }
    );
    const token = stdout.trim();
    if (token && token.startsWith("sk-ant-oat")) {
      return token;
    }
  } catch (error) {
    debug("Linux secret-tool retrieval failed:", error);
  }

  // Try config file locations
  const configPaths = [
    path.join(os.homedir(), ".claude", ".credentials.json"),
    path.join(os.homedir(), ".claude", "credentials.json"),
    path.join(os.homedir(), ".config", "claude-code", "credentials.json"),
  ];

  for (const configPath of configPaths) {
    try {
      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, "utf-8");
        const config = JSON.parse(content);

        // Check for claudeAiOauth.accessToken structure
        if (config.claudeAiOauth && typeof config.claudeAiOauth === "object") {
          const token = config.claudeAiOauth.accessToken;
          if (token && typeof token === "string" && token.startsWith("sk-ant-oat")) {
            debug(`Found OAuth token in ${configPath} under claudeAiOauth.accessToken`);
            return token;
          }
        }

        // Check for direct token fields
        for (const key of ["oauth_token", "token", "accessToken"]) {
          const token = config[key];
          if (token && typeof token === "string" && token.startsWith("sk-ant-oat")) {
            debug(`Found OAuth token in ${configPath} under key ${key}`);
            return token;
          }
        }
      }
    } catch (error) {
      debug(`Failed to read config from ${configPath}:`, error);
    }
  }

  return null;
}

export async function getOAuthToken(): Promise<string | null> {
  const platform = process.platform;

  debug(`Attempting to retrieve OAuth token on platform: ${platform}`);

  switch (platform) {
    case "win32":
      return getOAuthTokenWindows();
    case "darwin":
      return getOAuthTokenMacOS();
    case "linux":
      return getOAuthTokenLinux();
    default:
      debug(`Unsupported platform for OAuth token retrieval: ${platform}`);
      return null;
  }
}

interface FetchResult {
  usage: OAuthUsageResponse | null;
  status: number | null;
}

export async function fetchUsageFromAPI(
  token: string
): Promise<FetchResult> {
  try {
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "claude-limitline/1.0.0",
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });

    if (!response.ok) {
      debug(`Usage API returned status ${response.status}: ${response.statusText}`);
      return { usage: null, status: response.status };
    }

    const data = (await response.json()) as ApiResponse;
    debug("Usage API response:", JSON.stringify(data));

    const parseUsageBlock = (block?: ApiUsageBlock): UsageData | null => {
      if (!block) return null;
      return {
        resetAt: block.resets_at ? new Date(block.resets_at) : new Date(),
        percentUsed: block.utilization ?? 0,
        isOverLimit: (block.utilization ?? 0) >= 100,
      };
    };

    return {
      usage: {
        fiveHour: parseUsageBlock(data.five_hour),
        sevenDay: parseUsageBlock(data.seven_day),
        sevenDayOpus: parseUsageBlock(data.seven_day_opus ?? undefined),
        sevenDaySonnet: parseUsageBlock(data.seven_day_sonnet ?? undefined),
        raw: data,
      },
      status: response.status,
    };
  } catch (error) {
    debug("Failed to fetch usage from API:", error);
    return { usage: null, status: null };
  }
}

// --- OAuth token refresh ---
// Rate limits on /api/oauth/usage are per-access-token.
// Refreshing the token gives a fresh rate limit window.

const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

interface RefreshResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

async function getRefreshToken(): Promise<string | null> {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      const { stdout } = await execAsync(
        `security find-generic-password -s "Claude Code-credentials" -w`,
        { timeout: 5000 }
      );
      const parsed = JSON.parse(stdout.trim());
      return parsed?.claudeAiOauth?.refreshToken ?? null;
    }
    if (platform === "linux") {
      const configPath = path.join(os.homedir(), ".claude", ".credentials.json");
      if (fs.existsSync(configPath)) {
        const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        return parsed?.claudeAiOauth?.refreshToken ?? null;
      }
    }
    if (platform === "win32") {
      const configPath = path.join(os.homedir(), ".claude", ".credentials.json");
      if (fs.existsSync(configPath)) {
        const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        return parsed?.claudeAiOauth?.refreshToken ?? null;
      }
    }
  } catch (error) {
    debug("Failed to retrieve refresh token:", error);
  }
  return null;
}

async function updateCredentials(accessToken: string, refreshToken: string): Promise<boolean> {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      // Read existing keychain entry, update tokens, write back
      const { stdout } = await execAsync(
        `security find-generic-password -s "Claude Code-credentials" -w`,
        { timeout: 5000 }
      );
      const parsed = JSON.parse(stdout.trim());
      parsed.claudeAiOauth.accessToken = accessToken;
      parsed.claudeAiOauth.refreshToken = refreshToken;
      const newJson = JSON.stringify(parsed);

      // macOS keychain requires delete-then-add for updates
      await execAsync(
        `security delete-generic-password -s "Claude Code-credentials"`,
        { timeout: 5000 }
      ).catch(() => { /* may not exist */ });
      await execAsync(
        `security add-generic-password -s "Claude Code-credentials" -a "Claude Code" -w ${JSON.stringify(newJson)}`,
        { timeout: 5000 }
      );
      debug("Updated macOS Keychain with refreshed OAuth tokens");
      return true;
    }
    if (platform === "linux" || platform === "win32") {
      const configPath = path.join(os.homedir(), ".claude", ".credentials.json");
      if (fs.existsSync(configPath)) {
        const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        parsed.claudeAiOauth.accessToken = accessToken;
        parsed.claudeAiOauth.refreshToken = refreshToken;
        fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2), "utf-8");
        debug(`Updated credentials in ${configPath}`);
        return true;
      }
    }
  } catch (error) {
    debug("Failed to update credentials:", error);
  }
  return false;
}

async function refreshOAuthToken(): Promise<string | null> {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) {
    debug("No refresh token available");
    return null;
  }

  try {
    debug("Attempting OAuth token refresh to bypass 429 rate limit");
    const response = await fetch("https://console.anthropic.com/v1/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
    });

    if (!response.ok) {
      debug(`Token refresh failed with status ${response.status}`);
      return null;
    }

    const data = (await response.json()) as RefreshResponse;
    if (!data.access_token || !data.refresh_token) {
      debug("Token refresh response missing required fields");
      return null;
    }

    // Persist both tokens — refresh tokens are one-time use
    const updated = await updateCredentials(data.access_token, data.refresh_token);
    if (!updated) {
      debug("WARNING: Token refreshed but could not persist to credentials store");
    }

    debug("OAuth token refreshed successfully");
    return data.access_token;
  } catch (error) {
    debug("OAuth token refresh error:", error);
    return null;
  }
}

// File-based cache for API responses to persist across process invocations.
// The status line runs as a short-lived process each refresh, so in-memory
// caching is ineffective — we must serialize to disk.

const CACHE_FILE = path.join(os.homedir(), ".claude", ".limitline-cache.json");

interface DiskCache {
  timestamp: number;           // Last successful fetch
  lastAttempt: number;         // Last fetch attempt (success or failure)
  usage: SerializedUsageResponse | null;
  previousUsage: SerializedUsageResponse | null;
}

// Minimum seconds between API calls, even on failure (backoff)
const MIN_RETRY_MS = 5 * 60 * 1000; // 5 minutes

// Dates can't round-trip through JSON, so we store them as ISO strings
interface SerializedUsageData {
  resetAt: string;
  percentUsed: number;
  isOverLimit: boolean;
}

interface SerializedUsageResponse {
  fiveHour: SerializedUsageData | null;
  sevenDay: SerializedUsageData | null;
  sevenDayOpus: SerializedUsageData | null;
  sevenDaySonnet: SerializedUsageData | null;
}

function serializeUsage(u: OAuthUsageResponse): SerializedUsageResponse {
  const s = (d: UsageData | null): SerializedUsageData | null =>
    d ? { resetAt: d.resetAt.toISOString(), percentUsed: d.percentUsed, isOverLimit: d.isOverLimit } : null;
  return {
    fiveHour: s(u.fiveHour),
    sevenDay: s(u.sevenDay),
    sevenDayOpus: s(u.sevenDayOpus),
    sevenDaySonnet: s(u.sevenDaySonnet),
  };
}

function deserializeUsage(s: SerializedUsageResponse): OAuthUsageResponse {
  const d = (v: SerializedUsageData | null): UsageData | null =>
    v ? { resetAt: new Date(v.resetAt), percentUsed: v.percentUsed, isOverLimit: v.isOverLimit } : null;
  return {
    fiveHour: d(s.fiveHour),
    sevenDay: d(s.sevenDay),
    sevenDayOpus: d(s.sevenDayOpus),
    sevenDaySonnet: d(s.sevenDaySonnet),
  };
}

function readDiskCache(): DiskCache | null {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const content = fs.readFileSync(CACHE_FILE, "utf-8");
      return JSON.parse(content) as DiskCache;
    }
  } catch (error) {
    debug("Failed to read disk cache:", error);
  }
  return null;
}

function writeDiskCache(cache: DiskCache): void {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), "utf-8");
  } catch (error) {
    debug("Failed to write disk cache:", error);
  }
}

export type TrendDirection = "up" | "down" | "same" | null;

export interface TrendInfo {
  fiveHourTrend: TrendDirection;
  sevenDayTrend: TrendDirection;
  sevenDayOpusTrend: TrendDirection;
  sevenDaySonnetTrend: TrendDirection;
}

export function getUsageTrend(): TrendInfo {
  const result: TrendInfo = {
    fiveHourTrend: null,
    sevenDayTrend: null,
    sevenDayOpusTrend: null,
    sevenDaySonnetTrend: null,
  };

  const cache = readDiskCache();
  if (!cache?.usage || !cache?.previousUsage) {
    return result;
  }

  const current = deserializeUsage(cache.usage);
  const previous = deserializeUsage(cache.previousUsage);

  const compareTrend = (
    cur: UsageData | null,
    prev: UsageData | null
  ): TrendDirection => {
    if (!cur || !prev) return null;
    const diff = cur.percentUsed - prev.percentUsed;
    if (diff > 0.5) return "up";
    if (diff < -0.5) return "down";
    return "same";
  };

  result.fiveHourTrend = compareTrend(current.fiveHour, previous.fiveHour);
  result.sevenDayTrend = compareTrend(current.sevenDay, previous.sevenDay);
  result.sevenDayOpusTrend = compareTrend(current.sevenDayOpus, previous.sevenDayOpus);
  result.sevenDaySonnetTrend = compareTrend(current.sevenDaySonnet, previous.sevenDaySonnet);

  return result;
}

// Single in-flight fetch promise to deduplicate concurrent calls within the same process
let inflight: Promise<OAuthUsageResponse | null> | null = null;

export async function getRealtimeUsage(
  pollIntervalMinutes: number = 15
): Promise<OAuthUsageResponse | null> {
  const now = Date.now();
  const pollIntervalMs = pollIntervalMinutes * 60 * 1000;

  // Check file-based cache first
  const diskCache = readDiskCache();
  if (diskCache?.usage && (now - diskCache.timestamp) < pollIntervalMs) {
    debug(`Using cached usage data (age: ${Math.round((now - diskCache.timestamp) / 1000)}s)`);
    return deserializeUsage(diskCache.usage);
  }

  // Don't retry too soon after a failed attempt (backoff)
  if (diskCache?.lastAttempt && (now - diskCache.lastAttempt) < MIN_RETRY_MS) {
    debug(`Backing off after recent attempt (${Math.round((now - diskCache.lastAttempt) / 1000)}s ago)`);
    return diskCache.usage ? deserializeUsage(diskCache.usage) : null;
  }

  // Deduplicate concurrent calls within the same process invocation
  // (block and weekly providers both call this via Promise.all)
  if (inflight) {
    debug("Waiting on in-flight fetch");
    return inflight;
  }

  inflight = (async () => {
    const token = await getOAuthToken();
    if (!token) {
      debug("Could not retrieve OAuth token for realtime usage");
      return null;
    }

    let result = await fetchUsageFromAPI(token);

    // On 429, try refreshing the OAuth token for a fresh rate limit window
    if (result.status === 429) {
      debug("Got 429 rate limit — attempting token refresh");
      const newToken = await refreshOAuthToken();
      if (newToken) {
        result = await fetchUsageFromAPI(newToken);
      }
    }

    if (result.usage) {
      const newCache: DiskCache = {
        timestamp: now,
        lastAttempt: now,
        usage: serializeUsage(result.usage),
        previousUsage: diskCache?.usage ?? null,
      };
      writeDiskCache(newCache);
      debug("Refreshed realtime usage cache (persisted to disk)");
      return result.usage;
    }

    // API failed — record the attempt to enable backoff
    const failCache: DiskCache = {
      timestamp: diskCache?.timestamp ?? 0,
      lastAttempt: now,
      usage: diskCache?.usage ?? null,
      previousUsage: diskCache?.previousUsage ?? null,
    };
    writeDiskCache(failCache);

    // Return stale cached data if available rather than nothing
    if (diskCache?.usage) {
      debug("API call failed, returning stale cached data");
      return deserializeUsage(diskCache.usage);
    }
    return null;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export function clearUsageCache(): void {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      fs.unlinkSync(CACHE_FILE);
    }
  } catch (error) {
    debug("Failed to clear disk cache:", error);
  }
}
