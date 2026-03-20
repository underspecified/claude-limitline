// Terminal utility functions

export function getTerminalWidth(): number {
  // When run as a statusline command, stdout is a pipe so columns is undefined.
  // COLUMNS env var (set by the shell) is a more reliable fallback.
  return process.stdout.columns
    || (process.env.COLUMNS ? parseInt(process.env.COLUMNS, 10) : 0)
    || 80;
}

// Calculate visible length of string (excluding ANSI codes)
export function visibleLength(str: string): number {
  // Remove ANSI escape codes
  const stripped = str.replace(/\x1b\[[0-9;]*m/g, "");
  return stripped.length;
}

// Format with ANSI colors
export function colorize(text: string, fg: string, bg?: string): string {
  let result = fg + text;
  if (bg) {
    result = bg + result;
  }
  return result + "\x1b[0m";
}
