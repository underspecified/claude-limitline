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

// A credential as read from the OS store. `expiresAt` is the OAuth access
// token's expiry in epoch ms, or null when the source can't tell us (e.g. a
// raw token with no surrounding JSON). The caller uses it to skip API calls
// with a known-expired token instead of burning a 429 (see getRealtimeUsage).
export interface OAuthCredential {
  token: string;
  expiresAt: number | null;
}

// Parse the JSON blob Claude Code stores in the keychain / credentials file.
// Returns the access token plus its expiry, or null if the blob has no usable
// `sk-ant-oat` token. Also accepts a bare raw token (expiry unknown).
function parseKeychainCredential(content: string): OAuthCredential | null {
  if (content.startsWith("{")) {
    try {
      const parsed = JSON.parse(content);
      const oauth = parsed.claudeAiOauth;
      if (oauth && typeof oauth === "object") {
        const token = oauth.accessToken;
        if (typeof token === "string" && token.startsWith("sk-ant-oat")) {
          const expiresAt =
            typeof oauth.expiresAt === "number" ? oauth.expiresAt : null;
          return { token, expiresAt };
        }
      }
    } catch (parseError) {
      debug("Failed to parse keychain JSON:", parseError);
    }
  }
  if (content.startsWith("sk-ant-oat")) {
    return { token: content, expiresAt: null };
  }
  return null;
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

async function getOAuthCredentialMacOS(): Promise<OAuthCredential | null> {
  // The keychain can hold MULTIPLE "Claude Code-credentials" generic-password
  // items that differ only by account. Claude Code writes the live token under
  // an account matching the OS username; an older login can leave an orphan
  // item under a different account (e.g. "Claude Code") that is never refreshed
  // and stays perpetually expired. A bare `-s service -w` lookup returns an
  // unspecified one — often the stale orphan. So query the current user's
  // account FIRST, then fall back to the service-only lookup for setups that
  // store under a different account name.
  const username = os.userInfo().username;
  const queries: { cmd: string; via: string }[] = [
    {
      cmd: `security find-generic-password -s "Claude Code-credentials" -a "${username}" -w`,
      via: `account '${username}'`,
    },
    {
      cmd: `security find-generic-password -s "Claude Code-credentials" -w`,
      via: "service-only",
    },
  ];

  for (const { cmd, via } of queries) {
    try {
      const { stdout } = await execAsync(cmd, { timeout: 5000 });
      const cred = parseKeychainCredential(stdout.trim());
      if (cred) {
        debug(`Found OAuth token in macOS Keychain via ${via}`);
        return cred;
      }
    } catch (error) {
      debug(`macOS Keychain retrieval failed (${via}):`, error);
    }
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

export async function getOAuthCredential(): Promise<OAuthCredential | null> {
  const platform = process.platform;

  debug(`Attempting to retrieve OAuth token on platform: ${platform}`);

  switch (platform) {
    case "darwin":
      return getOAuthCredentialMacOS();
    case "win32": {
      // Windows/Linux getters don't surface expiry yet; expiresAt=null means
      // "unknown", which the caller treats as usable (current behavior).
      const token = await getOAuthTokenWindows();
      return token ? { token, expiresAt: null } : null;
    }
    case "linux": {
      const token = await getOAuthTokenLinux();
      return token ? { token, expiresAt: null } : null;
    }
    default:
      debug(`Unsupported platform for OAuth token retrieval: ${platform}`);
      return null;
  }
}

// Back-compat wrapper: callers/tests that only need the token string.
export async function getOAuthToken(): Promise<string | null> {
  const cred = await getOAuthCredential();
  return cred?.token ?? null;
}

interface FetchResult {
  usage: OAuthUsageResponse | null;
  status: number | null;
  // Server-requested cool-off in ms (from the Retry-After header on 429/529).
  // null when the response carried no usable Retry-After.
  retryAfterMs: number | null;
}

// Parse a Retry-After header (RFC 7231: delta-seconds or HTTP-date) into ms.
export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
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
      const retryAfterMs = parseRetryAfter(response.headers?.get("retry-after") ?? null);
      if (retryAfterMs !== null) {
        debug(`Usage API asked to retry after ${Math.round(retryAfterMs / 1000)}s`);
      }
      return { usage: null, status: response.status, retryAfterMs };
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
      retryAfterMs: null,
    };
  } catch (error) {
    debug("Failed to fetch usage from API:", error);
    return { usage: null, status: null, retryAfterMs: null };
  }
}

// NOTE: limitline used to refresh the OAuth token itself on 401/429 (POST the
// keychain refresh_token to console.anthropic.com, then rewrite the keychain).
// That was removed: refresh tokens are ONE-TIME USE, and Claude Code refreshes
// from the same shared keychain credential. Whoever rotates first invalidates
// the other's copy, so limitline's refresh raced Claude Code, kept failing, and
// served hours-stale cached usage forever. Claude Code now owns keychain
// freshness; limitline only reads the token and shows no usage on 401/403.

// File-based cache for API responses to persist across process invocations.
// The status line runs as a short-lived process each refresh, so in-memory
// caching is ineffective — we must serialize to disk.

const CACHE_FILE = path.join(os.homedir(), ".claude", ".limitline-cache.json");

interface DiskCache {
  timestamp: number;           // Last successful fetch
  lastAttempt: number;         // Last fetch attempt (success or failure)
  retryUntil?: number;         // Epoch ms before which no process should re-hit the API
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

  // Check file-based cache first. The freshness window gets a per-process jitter
  // (up to 90s) so a fleet of sessions sharing this cache don't all decide the
  // data is stale in the same instant and stampede the API at once — whichever
  // session crosses its (slightly longer) window first refetches and rewrites
  // `timestamp`, which keeps the data fresh for the rest.
  const freshnessMs = pollIntervalMs + Math.random() * 90 * 1000;
  const diskCache = readDiskCache();
  if (diskCache?.usage && (now - diskCache.timestamp) < freshnessMs) {
    debug(`Using cached usage data (age: ${Math.round((now - diskCache.timestamp) / 1000)}s)`);
    return deserializeUsage(diskCache.usage);
  }

  // Honor a server-requested cool-off (Retry-After on 429/529). This is the key
  // coordination point for a fleet of sessions: all of them share this cache
  // file, so once one render records the deadline, the rest stay silent until
  // the rate-limit window genuinely clears instead of perpetually re-pinning it.
  // Per-process jitter staggers the herd at expiry so they don't all re-fire in
  // the same instant and immediately re-trip a freshly-reset window.
  if (diskCache?.retryUntil && now < diskCache.retryUntil) {
    const jitterMs = Math.random() * 30 * 1000;
    if (now < diskCache.retryUntil + jitterMs) {
      debug(`Honoring Retry-After cool-off (${Math.round((diskCache.retryUntil - now) / 1000)}s left)`);
      return null;
    }
  }

  // Don't retry too soon after a failed attempt (backoff). We do NOT serve the
  // last cached usage here: anything past the pollInterval freshness check above
  // is stale, and showing stale numbers is exactly the bug this avoids.
  if (diskCache?.lastAttempt && (now - diskCache.lastAttempt) < MIN_RETRY_MS) {
    debug(`Backing off after recent attempt (${Math.round((now - diskCache.lastAttempt) / 1000)}s ago)`);
    return null;
  }

  // Deduplicate concurrent calls within the same process invocation
  // (block and weekly providers both call this via Promise.all)
  if (inflight) {
    debug("Waiting on in-flight fetch");
    return inflight;
  }

  inflight = (async () => {
    const cred = await getOAuthCredential();
    if (!cred?.token) {
      debug("Could not retrieve OAuth token for realtime usage");
      return null;
    }

    // Expiry guard. Claude Code writes the keychain token at session start and
    // refreshes its in-memory copy as needed; the on-disk copy can lag past
    // expiry. Sending an expired token to the usage endpoint returns 429
    // (rate_limit_error, NOT 401), which would arm a 1-hour fleet-wide cool-off
    // below and hide usage indefinitely — the exact bug that showed "--"
    // forever. Skip the API call entirely (keychain reads are local and cheap)
    // and let a later render pick up the token once Claude Code rewrites it.
    // We do NOT touch the cache here: no failed-attempt backoff, no cool-off.
    if (cred.expiresAt !== null && cred.expiresAt <= now) {
      const ageMin = Math.round((now - cred.expiresAt) / 60000);
      debug(
        `Keychain token expired ${ageMin}m ago; skipping API until Claude Code refreshes it`
      );
      return null;
    }

    const result = await fetchUsageFromAPI(cred.token);

    // No self-refresh on 401/429 (see note above): a 401 means Claude Code's
    // keychain token is expired — it will refresh on its own use; a 403 means
    // the token lacks the usage scope (e.g. a setup-token). Either way we just
    // report no usage this render rather than racing the credential store.

    if (result.usage) {
      const newCache: DiskCache = {
        timestamp: now,
        lastAttempt: now,
        retryUntil: 0, // success clears any prior cool-off
        usage: serializeUsage(result.usage),
        previousUsage: diskCache?.usage ?? null,
      };
      writeDiskCache(newCache);
      debug("Refreshed realtime usage cache (persisted to disk)");
      return result.usage;
    }

    // API failed. Record the attempt to enable backoff. We keep the previous
    // usage/timestamp in the cache (so trend survives a brief blip and the old
    // timestamp keeps the freshness check above from serving it), but we return
    // null now — a failed render shows no usage rather than stale numbers.
    // If the server sent a Retry-After, persist that deadline so the whole fleet
    // backs off for the full window; otherwise fall back to the MIN_RETRY_MS floor.
    const coolOffMs = result.retryAfterMs ?? MIN_RETRY_MS;
    const failCache: DiskCache = {
      timestamp: diskCache?.timestamp ?? 0,
      lastAttempt: now,
      retryUntil: now + coolOffMs,
      usage: diskCache?.usage ?? null,
      previousUsage: diskCache?.previousUsage ?? null,
    };
    writeDiskCache(failCache);
    debug(`API call failed (status ${result.status ?? "n/a"}); reporting no usage`);
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
