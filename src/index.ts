#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "./config/index.js";
import { BlockProvider } from "./segments/block.js";
import { WeeklyProvider } from "./segments/weekly.js";
import { Renderer } from "./renderer.js";
import { getEnvironmentInfo } from "./utils/environment.js";
import { readHookData } from "./utils/claude-hook.js";
import { resolveUsage } from "./utils/usage.js";
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

    // Usage per window: this session's own stdin `rate_limits` when usable,
    // else the OAuth path (see resolveUsage).
    const { usage, trendInfo, authFailing } = await resolveUsage(hookData?.rate_limits, {
      pollInterval: config.budget?.pollInterval ?? 15,
      showTrend: config.showTrend ?? false,
      fiveHour: config.block?.enabled ?? false,
      sevenDay: config.weekly?.enabled ?? false,
    });

    const blockInfo = config.block?.enabled ? new BlockProvider().getBlockInfo(usage) : null;
    const weeklyInfo = config.weekly?.enabled
      ? new WeeklyProvider().getWeeklyInfo(
          usage,
          config.budget?.resetDay,
          config.budget?.resetHour,
          config.budget?.resetMinute
        )
      : null;

    debug("Block info:", JSON.stringify(blockInfo));
    debug("Weekly info:", JSON.stringify(weeklyInfo));
    debug("Trend info:", JSON.stringify(trendInfo));

    // Render output
    const renderer = new Renderer(config);
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
