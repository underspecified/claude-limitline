#!/usr/bin/env node
// limitline-auth.mjs — one-time OAuth authorization for claude-limitline.
//
// Mints an INDEPENDENT Claude OAuth credential (its own access+refresh token,
// with the user:profile scope the usage endpoint requires) and stores it in
// ~/.claude/claude-limitline-credentials.json. Because this is a separate
// authorization from `claude /login`, refreshing it never touches Claude Code's
// session credential — so limitline can self-refresh it indefinitely without
// racing Claude Code's rotation.
//
// Run interactively:  node limitline-auth.mjs
//
// Flow: prints an authorize URL (also tries to open it), you approve in the
// browser, copy the displayed code, and paste it back here. The script then
// exchanges it, writes the credential file (0600), and verifies the usage API.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPE = "user:profile user:inference";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CREDS_FILE = path.join(os.homedir(), ".claude", "claude-limitline-credentials.json");

const b64url = (buf) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

function tryOpen(url) {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "explorer"
    : "xdg-open";
  try { spawn(cmd, [url], { stdio: "ignore", detached: true }).unref(); } catch { /* ignore */ }
}

async function main() {
  const { verifier, challenge } = pkce();
  const state = b64url(crypto.randomBytes(32));

  const url = `${AUTHORIZE_URL}?code=true&client_id=${CLIENT_ID}` +
    `&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent(SCOPE)}` +
    `&code_challenge=${challenge}&code_challenge_method=S256&state=${state}`;

  console.log("\n1. Open this URL and approve access (it should open automatically):\n");
  console.log("   " + url + "\n");
  tryOpen(url);
  console.log("2. After approving, the page shows a code (it may look like `CODE#STATE`).");
  const pasted = await ask("3. Paste the code here: ");
  if (!pasted) { console.error("No code entered. Aborting."); process.exit(1); }

  // The console callback presents the code as `code#state`.
  const [code, returnedState] = pasted.split("#");
  if (returnedState && returnedState !== state) {
    console.error("WARNING: returned state does not match — possible CSRF. Aborting.");
    process.exit(1);
  }

  console.log("\nExchanging code for tokens…");
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "claude-limitline" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      state: returnedState ?? state,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    console.error(`Token exchange failed: HTTP ${resp.status}`);
    console.error(body.slice(0, 400));
    process.exit(2);
  }

  const data = await resp.json();
  if (!data.access_token || !data.refresh_token || !data.expires_in) {
    console.error("Token response missing required fields:", Object.keys(data).join(", "));
    process.exit(3);
  }

  const cred = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes: data.scope ?? SCOPE,
    obtainedAt: Date.now(),
  };
  fs.mkdirSync(path.dirname(CREDS_FILE), { recursive: true });
  fs.writeFileSync(CREDS_FILE, JSON.stringify(cred, null, 2), { mode: 0o600 });
  fs.chmodSync(CREDS_FILE, 0o600);
  console.log(`\n✓ Wrote ${CREDS_FILE}`);
  console.log(`  scopes: ${cred.scopes}`);
  console.log(`  access token valid ~${Math.round(data.expires_in / 3600)}h; refresh token stored for self-renewal`);

  // Verify the token actually works on the usage endpoint.
  console.log("\nVerifying against the usage endpoint…");
  const u = await fetch(USAGE_URL, {
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "claude-limitline/1.0.0",
      Authorization: `Bearer ${data.access_token}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
  });
  console.log(`usage API: HTTP ${u.status}`);
  if (u.ok) {
    const usage = await u.json();
    const fh = usage.five_hour?.utilization ?? "n/a";
    const sd = usage.seven_day?.utilization ?? "n/a";
    console.log(`✓ SUCCESS — five_hour utilization: ${fh}, seven_day: ${sd}`);
    console.log("\nThe budgetline will now use this credential and self-refresh it.");
  } else {
    const body = await u.text().catch(() => "");
    console.error("✗ Usage endpoint rejected the token:", body.slice(0, 300));
    console.error("(The scope may not have been granted. Credential file was still written.)");
    process.exit(4);
  }
}

main().catch((e) => { console.error("Error:", e?.message ?? e); process.exit(1); });
