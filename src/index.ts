#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "./config/index.js";
import { BlockProvider } from "./segments/block.js";
import { WeeklyProvider } from "./segments/weekly.js";
import { Renderer } from "./renderer.js";
import { getEnvironmentInfo } from "./utils/environment.js";
import { readHookData, usageFromRateLimits } from "./utils/claude-hook.js";
import { getUsageTrend, isLimitlineAuthFailing } from "./utils/oauth.js";
import { debug } from "./utils/logger.js";

// Untracked, per-box theme override. Lets the statusline follow OS dark/light
// without churning the lnk-tracked config: the tracked config keeps a static
// theme; the toggle_claude_theme hook (macOS dark-mode-notify / Linux darkman)
// writes the current palette name here, and it wins on the next render.
function resolveThemeOverride(): string | undefined {
  const overridePath = path.join(os.homedir(), ".claude", ".claude-limitline-theme");
  try {
    if (fs.existsSync(overridePath)) {
      const value = fs.readFileSync(overridePath, "utf-8").trim();
      if (value) return value;
    }
  } catch (error) {
    debug("Theme override read failed:", error);
  }
  return undefined;
}

async function main(): Promise<void> {
  try {
    // Load configuration
    const config = loadConfig();
    const themeOverride = resolveThemeOverride();
    if (themeOverride) config.theme = themeOverride;
    debug("Config loaded:", JSON.stringify(config));

    // Read hook data from stdin (Claude Code passes this)
    const hookData = await readHookData();
    debug("Hook data:", JSON.stringify(hookData));

    // Get environment info (repo name, git branch, model)
    const envInfo = getEnvironmentInfo(hookData, config.context?.maxTokens);
    debug("Environment info:", JSON.stringify(envInfo));

    // Initialize providers
    const blockProvider = new BlockProvider();
    const weeklyProvider = new WeeklyProvider();

    // Get data
    const pollInterval = config.budget?.pollInterval ?? 15;

    // Claude Code's own `rate_limits` for this session's account. When present,
    // it replaces the OAuth path entirely: no network, no shared usage cache.
    const stdinUsage = usageFromRateLimits(hookData?.rate_limits);
    debug("Usage source:", stdinUsage ? "stdin rate_limits" : "OAuth API");

    const [blockInfo, weeklyInfo] = await Promise.all([
      config.block?.enabled ? blockProvider.getBlockInfo(pollInterval, stdinUsage) : null,
      config.weekly?.enabled
        ? weeklyProvider.getWeeklyInfo(
            config.budget?.resetDay,
            config.budget?.resetHour,
            config.budget?.resetMinute,
            pollInterval,
            stdinUsage
          )
        : null,
    ]);

    debug("Block info:", JSON.stringify(blockInfo));
    debug("Weekly info:", JSON.stringify(weeklyInfo));

    // Get trend info for usage changes. Trend and auth! both describe the
    // OAuth path's shared cache and credential, so the stdin path skips them.
    const trendInfo = config.showTrend && !stdinUsage ? getUsageTrend() : null;
    debug("Trend info:", JSON.stringify(trendInfo));

    // Render output
    const renderer = new Renderer(config);
    const authFailing = !stdinUsage && isLimitlineAuthFailing();
    const output = renderer.render(blockInfo, weeklyInfo, envInfo, trendInfo, authFailing);

    if (output) {
      process.stdout.write(output);
    }
  } catch (error) {
    debug("Error in main:", error);
    // Silent failure for statusline - don't break the terminal
    process.exit(0);
  }
}

main();
