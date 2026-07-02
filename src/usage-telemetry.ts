#!/usr/bin/env bun
/**
 * usage-telemetry — deterministic dual-plan usage collector (no LLM).
 *
 * Collects:
 *   - Claude plan meters: GET https://api.anthropic.com/api/oauth/usage with
 *     Claude Code's own keychain OAuth token (CC keeps it refreshed).
 *     Validated 2026-06-10 against the claude.ai usage page: identical data.
 *   - Codex plan meters: codex app-server `account/rateLimits/read` over a
 *     short-lived stdio child (first-party protocol; rides CLI auth).
 *
 * Publishes ONE signed wire event per run:
 *   topic usage.telemetry, dest $TELEMETRY_DEST (default brioche), payload
 *   { status: "ok"|"failed", collected_at, claude?, codex?, errors? }.
 *
 * FAIL-LOUD CONTRACT: any collector error still publishes the event with
 * status="failed" and the error strings — silence is never a valid output.
 * If even the publish fails, the process exits non-zero so launchd logs it.
 *
 * Env: AGENT_ID + AGENT_PRIVATE_KEY (dedicated telemetry identity),
 *      WIRE_URL, TELEMETRY_DEST (default brioche).
 */

import { execSync } from "child_process";
import { createAuthJwt, importKeyPair } from "@agiterra/wire-tools/crypto";
import { CodexAppServer } from "./app-server.js";

const WIRE_URL = (process.env.WIRE_URL ?? "http://localhost:9800").replace(/\/$/, "");
const DEST = process.env.TELEMETRY_DEST ?? "brioche";
const AGENT_ID = process.env.AGENT_ID ?? "usage-telemetry";

type Window = { used_percent: number | null; resets_at: string | null; window_mins?: number | null };
const errors: string[] = [];

function isoFromEpochSec(s: unknown): string | null {
  return typeof s === "number" ? new Date(s * 1000).toISOString() : null;
}

/** Parse a credentials blob → {token, expiresAt} or null. */
function parseCred(raw: string): { token: string; expiresAt: number } | null {
  try {
    const o = JSON.parse(raw)?.claudeAiOauth;
    if (!o?.accessToken) return null;
    return { token: o.accessToken, expiresAt: Number(o.expiresAt ?? 0) };
  } catch {
    return null;
  }
}

async function collectClaude(): Promise<Record<string, Window | string> | null> {
  try {
    // Pick the FRESHEST UNEXPIRED token across both sources. A blind
    // keychain-first / file-fallback (the old shape) fed the stale file's token
    // straight to the API whenever the LaunchAgent's non-interactive keychain
    // read hiccupped → spurious oauth/usage 401 (the credential-sync-fanned
    // file is access-token-only and goes stale; keychain stays CC-refreshed).
    const sources: Array<{ name: string; read: () => string }> = [
      { name: "keychain", read: () => execSync('security find-generic-password -s "Claude Code-credentials" -w', { encoding: "utf8" }) },
      { name: "file", read: () => execSync(`cat "${process.env.HOME}/.claude/.credentials.json"`, { encoding: "utf8" }) },
    ];
    const now = Date.now();
    let best: { token: string; expiresAt: number; name: string } | null = null;
    for (const s of sources) {
      let cred: { token: string; expiresAt: number } | null = null;
      try { cred = parseCred(s.read()); } catch { cred = null; }
      if (!cred) continue;
      if (cred.expiresAt && cred.expiresAt <= now) continue; // skip expired
      if (!best || cred.expiresAt > best.expiresAt) best = { ...cred, name: s.name };
    }
    if (!best) throw new Error("no unexpired claudeAiOauth.accessToken in keychain or credentials file — collector cred stale (needs a CC token refresh / re-login on this host)");
    const token = best.token;

    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
    });
    if (!res.ok) throw new Error(`oauth/usage HTTP ${res.status}`);
    const d = (await res.json()) as Record<string, { utilization?: number; resets_at?: string } | null>;
    const win = (k: string): Window => ({
      used_percent: d[k]?.utilization ?? null,
      resets_at: d[k]?.resets_at ?? null,
    });
    return {
      plan: "claude_max",
      five_hour: win("five_hour"),
      seven_day: win("seven_day"),
      seven_day_sonnet: win("seven_day_sonnet"),
      seven_day_opus: win("seven_day_opus"),
    };
  } catch (e) {
    errors.push(`claude: ${String(e)}`);
    return null;
  }
}

async function collectCodex(): Promise<Record<string, unknown> | null> {
  const app = new CodexAppServer({ cwd: process.env.HOME ?? "/tmp" });
  try {
    await app.start();
    const r = (await app.request("account/rateLimits/read", {})) as {
      rateLimits?: {
        planType?: string;
        primary?: { usedPercent?: number; resetsAt?: number; windowDurationMins?: number };
        secondary?: { usedPercent?: number; resetsAt?: number; windowDurationMins?: number };
      };
    };
    const rl = r.rateLimits;
    if (!rl) throw new Error(`no rateLimits in response: ${JSON.stringify(r).slice(0, 200)}`);
    const win = (w?: { usedPercent?: number; resetsAt?: number; windowDurationMins?: number }): Window => ({
      used_percent: w?.usedPercent ?? null,
      resets_at: isoFromEpochSec(w?.resetsAt),
      window_mins: w?.windowDurationMins ?? null,
    });
    return {
      plan: rl.planType ?? "unknown",
      primary: win(rl.primary),
      secondary: win(rl.secondary),
    };
  } catch (e) {
    errors.push(`codex: ${String(e)}`);
    return null;
  } finally {
    app.stop();
  }
}

async function publishTopic(topic: string, payload: Record<string, unknown>): Promise<void> {
  const { privateKey } = await importKeyPair(
    process.env.AGENT_PRIVATE_KEY ?? (() => { throw new Error("AGENT_PRIVATE_KEY required"); })(),
  );
  const body = JSON.stringify(payload);
  const token = await createAuthJwt(privateKey, AGENT_ID, body);
  const res = await fetch(`${WIRE_URL}/webhooks/${DEST}/${topic}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body,
  });
  if (!res.ok) throw new Error(`wire publish HTTP ${res.status}: ${await res.text().catch(() => "")}`);
}

const claude = await collectClaude();
const codex = await collectCodex();
const payload = {
  source: AGENT_ID,
  status: errors.length === 0 ? "ok" : "failed",
  collected_at: new Date().toISOString(),
  ...(claude ? { claude } : {}),
  ...(codex ? { codex } : {}),
  ...(errors.length ? { errors } : {}),
};

// Dual-plan balance watcher (Brioche, j:333): ping when a plan is over-pace
// so load can shift to the other. Claude 7-day >60% = slow Claude / lean
// Codex; Codex weekly (secondary window) >80% = rebalance toward Claude.
// Thresholds overridable via env for tuning without a redeploy.
const CLAUDE_7D_MAX = Number(process.env.ALERT_CLAUDE_7D ?? "60");
const CODEX_WEEKLY_MAX = Number(process.env.ALERT_CODEX_WEEKLY ?? "80");
const claudeWeekly = (claude?.seven_day as { used_percent?: number | null } | undefined)?.used_percent ?? null;
const codexWeekly = (codex?.secondary as { used_percent?: number | null } | undefined)?.used_percent ?? null;
const breaches: string[] = [];
if (typeof claudeWeekly === "number" && claudeWeekly > CLAUDE_7D_MAX) {
  breaches.push(`Claude 7-day at ${claudeWeekly}% (>${CLAUDE_7D_MAX}%) — over-pace, shift load to Codex`);
}
if (typeof codexWeekly === "number" && codexWeekly > CODEX_WEEKLY_MAX) {
  breaches.push(`Codex weekly at ${codexWeekly}% (>${CODEX_WEEKLY_MAX}%) — rebalance toward Claude`);
}

try {
  await publishTopic("usage.telemetry", payload);
  console.log(`published usage.telemetry status=${payload.status}`);
  if (breaches.length) {
    // Higher-signal alert as an ipc message so it surfaces to Brioche directly,
    // not just in the telemetry stream.
    await publishTopic("ipc", {
      from: AGENT_ID,
      re: "DUAL-PLAN BALANCE ALERT",
      text: `Usage threshold crossed (${new Date().toISOString()}):\n- ${breaches.join("\n- ")}\nClaude 7d=${claudeWeekly ?? "?"}% | Codex weekly=${codexWeekly ?? "?"}%`,
      breaches,
    });
    console.log(`published ${breaches.length} balance alert(s)`);
  }
  process.exit(errors.length === 0 ? 0 : 1);
} catch (e) {
  console.error(`PUBLISH FAILED (telemetry data follows for launchd log): ${String(e)}\n${JSON.stringify(payload)}`);
  process.exit(2);
}
