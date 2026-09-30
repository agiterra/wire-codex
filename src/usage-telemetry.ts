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
 *      WIRE_URL, TELEMETRY_DEST (default brioche),
 *      USAGE_TELEMETRY_CLAUDE=off to skip the Claude poll on a host with no Claude
 *      login. The claude block then reads state=not_collected with null windows, and
 *      one ipc notice is sent per opt-out (marker file). See claude-cred-status.ts.
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { createAuthJwt, importKeyPair } from "@agiterra/wire-tools/crypto";
import { CodexAppServer } from "./app-server.js";
import { classifyCredBlob, describeCred, historyLine, nextHistory, noTokenMessage, noticeAction, NOT_COLLECTED_REASON, notCollectedBlock, parseClaudeSwitch, type ClaudeHistory } from "./claude-cred-status.js";

const WIRE_URL = (process.env.WIRE_URL ?? "http://localhost:9800").replace(/\/$/, "");
const DEST = process.env.TELEMETRY_DEST ?? "brioche";
const AGENT_ID = process.env.AGENT_ID ?? "usage-telemetry";

type Window = { used_percent: number | null; resets_at: string | null; window_mins?: number | null };
const errors: string[] = [];

function isoFromEpochSec(s: unknown): string | null {
  return typeof s === "number" ? new Date(s * 1000).toISOString() : null;
}

const HISTORY_FILE = `${process.env.HOME}/.wire/usage-telemetry.claude-history.json`;

/** Previous Claude failure history: null = no file yet (fresh counter), "unreadable" = present but unusable. */
function readHistory(): ClaudeHistory | null | "unreadable" {
  if (!existsSync(HISTORY_FILE)) return null;
  try {
    return JSON.parse(readFileSync(HISTORY_FILE, "utf8")) as ClaudeHistory;
  } catch (e) {
    console.error(`usage-telemetry: history file ${HISTORY_FILE} unreadable:`, e);
    return "unreadable";
  }
}

const prevHistory = readHistory();
let recordedHistory: ClaudeHistory | null | undefined;

/** Advance + persist the history exactly once per run; returns what the error text should cite. */
function recordHistory(ok: boolean): ClaudeHistory | null {
  if (recordedHistory !== undefined) return recordedHistory;
  if (prevHistory === "unreadable") return (recordedHistory = null);
  const h = nextHistory(prevHistory, ok, new Date().toISOString());
  try {
    const tmp = `${HISTORY_FILE}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(h) + "\n");
    renameSync(tmp, HISTORY_FILE);
  } catch (e) {
    console.error(`usage-telemetry: could not write ${HISTORY_FILE}:`, e);
  }
  return (recordedHistory = h);
}

async function collectClaude(): Promise<Record<string, Window | string> | null> {
  try {
    // Pick the FRESHEST UNEXPIRED token across both sources. A blind
    // keychain-first / file-fallback (the old shape) fed the stale file's token
    // straight to the API whenever the LaunchAgent's non-interactive keychain
    // read hiccupped → spurious oauth/usage 401 (the credential-sync-fanned
    // file is access-token-only and goes stale; keychain stays CC-refreshed).
    const credFile = `${process.env.HOME}/.claude/.credentials.json`;
    const sources: Array<{ name: string; read: () => string; mtime: () => string | null }> = [
      { name: "keychain", read: () => execSync('security find-generic-password -s "Claude Code-credentials" -w', { encoding: "utf8" }), mtime: () => null },
      { name: "file", read: () => readFileSync(credFile, "utf8"), mtime: () => statSync(credFile).mtime.toISOString() },
    ];
    // Evaluate one source, returning its cred (if usable) AND a status that
    // says what was OBSERVED (read failure / unparseable / parsed-but-no-token /
    // expired) — never a forecast. See claude-cred-status.ts.
    const evalSource = (s: (typeof sources)[number]): { cred: { token: string; expiresAt: number } | null; status: string } => {
      let raw: string;
      try { raw = s.read(); } catch (e) { return { cred: null, status: `read-failed (${String((e as Error).message ?? e).split("\n")[0].slice(0, 60)})` }; }
      let mtime: string | null = null;
      try { mtime = s.mtime(); } catch (e) { console.error(`usage-telemetry: mtime of ${s.name} failed:`, e); }
      const blob = classifyCredBlob(raw);
      const status = describeCred(blob, Date.now(), mtime);
      return { cred: blob.kind === "ok" ? { token: blob.token, expiresAt: blob.expiresAt } : null, status };
    };
    const pick = (): { token: string; expiresAt: number; name: string } | null => {
      let best: { token: string; expiresAt: number; name: string } | null = null;
      for (const s of sources) {
        const { cred } = evalSource(s);
        if (!cred) continue;
        if (cred.expiresAt && cred.expiresAt <= Date.now()) continue; // skip expired
        if (!best || cred.expiresAt > best.expiresAt) best = { ...cred, name: s.name };
      }
      return best;
    };
    // A source can miss at one instant (the gui LaunchAgent's non-interactive
    // keychain read has hiccupped; the file can be mid-rewrite), so retry
    // briefly before failing the run. (NB: CLAUDE_CODE_OAUTH_TOKEN / the
    // setup-token do NOT help — the setup-token lacks the user:profile scope
    // the oauth/usage endpoint requires; the fresh accessToken must come from
    // the keychain/file, kept refreshed by a running Claude Code.)
    let best = pick();
    for (let attempt = 0; !best && attempt < 3; attempt++) {
      await new Promise((r) => setTimeout(r, 800));
      best = pick();
    }
    if (!best) {
      const diag = sources.map((s) => `${s.name}: ${evalSource(s).status}`).join("; ");
      throw new Error(noTokenMessage(diag, recordHistory(false)));
    }
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
    recordHistory(true);
    return {
      plan: "claude_max",
      five_hour: win("five_hour"),
      seven_day: win("seven_day"),
      seven_day_sonnet: win("seven_day_sonnet"),
      seven_day_opus: win("seven_day_opus"),
    };
  } catch (e) {
    const already = recordedHistory !== undefined;
    const h = recordHistory(false);
    errors.push(`claude: ${String(e)}${already ? "" : ` — ${historyLine(h)}`}`);
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

const claudeSwitch = parseClaudeSwitch(process.env.USAGE_TELEMETRY_CLAUDE);
if (claudeSwitch.mode === "invalid") {
  errors.push(`config: USAGE_TELEMETRY_CLAUDE=${JSON.stringify(claudeSwitch.raw)} is not "on" or "off"; collecting Claude anyway`);
}
const claudeOff = claudeSwitch.mode === "off";
// Off: no poll, and the history file is left untouched (prevHistory is shown frozen).
const claude = claudeOff ? notCollectedBlock(prevHistory) : await collectClaude();
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

const NOTICE_MARKER = `${process.env.HOME}/.wire/usage-telemetry.claude-off-notified`;

try {
  await publishTopic("usage.telemetry", payload);
  console.log(`published usage.telemetry status=${payload.status}`);
  const act = noticeAction(claudeOff, existsSync(NOTICE_MARKER));
  if (act === "notify") {
    const h = prevHistory === "unreadable" ? null : prevHistory;
    await publishTopic("ipc", {
      from: AGENT_ID,
      re: "CLAUDE NOT COLLECTED ON THIS HOST",
      text: `Claude: not collected on this host — ${NOT_COLLECTED_REASON}. From now on usage.telemetry carries claude.state=not_collected with null windows (UNKNOWN, not 0%). Codex collection is unchanged. Failure history as it stood when polling stopped: ${historyLine(h)}. This notice is sent once; removing the env var resumes polling.`,
    });
    writeFileSync(NOTICE_MARKER, new Date().toISOString() + "\n");
    console.log("published one-time Claude not-collected notice");
  } else if (act === "clear") {
    try { unlinkSync(NOTICE_MARKER); } catch (e) { console.error(`usage-telemetry: could not clear ${NOTICE_MARKER}:`, e); }
  }
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
