#!/usr/bin/env bun
/**
 * freeze-watchdog — codex screen-freeze detector. ALARM-ONLY, never recycles.
 *
 * The freeze class (task #20, 2026-06-11): codex never kills a process running
 * in a PTY session (unified_exec). A hung command — classically a credential
 * prompt from credential-less git/gh over HTTPS — waits forever, the model
 * loop-polls it, and the turn never completes. The TUI sits in
 * 'Working───N───' indefinitely; relayed follow-ups stay unsubmitted. Neither
 * the shell exec timeout (10s default, model-overridable) nor the MCP tool
 * timeout (120s default) bounds this.
 *
 * Detection: enumerate crew-spawned codex agents (rows in ~/.wire/crews.db —
 * a documented convention surface, no crew-tools import), hardcopy each live
 * screen, NORMALIZE the frame (strip digits + spinner/box/block glyphs so the
 * ticking elapsed counter doesn't mask a frozen frame), and hash it. A frame
 * whose normalized hash is static for FREEZE_THRESHOLD_MIN while the TUI
 * shows the Working indicator is a freeze suspect.
 *
 * Action: ONE signed wire ipc message to WATCHDOG_DEST per suspect (re-alert
 * at most every REALERT_MIN). No auto-recycle — a long quiet build looks
 * identical to a hung prompt from the outside; killing on suspicion has
 * unbounded blast radius. The human (or orchestrator) verifies with
 * crew agent_read and decides.
 *
 * CAPTURE-FAILURE CONTRACT: a crews.db row whose screen_pid is DEAD is a
 * vanished session — skipped silently (lifecycle, not failure). But a row
 * whose screen_pid is ALIVE while `hardcopy` keeps failing is the opposite:
 * that is the exact codex freeze/death signature (financier/beignet/cannoli,
 * 2026-06-15 — their screens went "(Remote or dead)" yet lingered in crews.db,
 * so the frame-hash check never got a frame and all three died with no alarm).
 * Such an agent is tracked and ALERTED on after CAPTURE_FAIL_THRESHOLD_MIN,
 * same alarm-only discipline as a frozen frame. A publish failure exits
 * non-zero so launchd logs it.
 *
 * Env: AGENT_ID (default freeze-watchdog) + AGENT_PRIVATE_KEY (required to
 *      alert), WIRE_URL, WATCHDOG_DEST (default brioche),
 *      FREEZE_THRESHOLD_MIN (default 15), REALERT_MIN (default 60),
 *      CAPTURE_FAIL_THRESHOLD_MIN (default = FREEZE_THRESHOLD_MIN — minutes a
 *      crews.db-live agent may stay uncapturable before alerting),
 *      WATCH_RUNTIMES (default "codex" — codex-bridged is headless, no TUI),
 *      CREWS_DB, WORK_MARKER (regex, default "working", case-insensitive).
 */

import { createHash } from "crypto";
import { mkdirSync, statSync } from "fs";
import { Database } from "bun:sqlite";
import { $ } from "bun";
import { createAuthJwt, importKeyPair } from "@agiterra/wire-tools/crypto";

const WIRE_URL = (process.env.WIRE_URL ?? "http://localhost:9800").replace(/\/$/, "");
const DEST = process.env.WATCHDOG_DEST ?? "brioche";
const AGENT_ID = process.env.AGENT_ID ?? "freeze-watchdog";
const THRESHOLD_MIN = Number(process.env.FREEZE_THRESHOLD_MIN ?? "15");
const CAPTURE_FAIL_THRESHOLD_MIN = Number(
  process.env.CAPTURE_FAIL_THRESHOLD_MIN ?? String(THRESHOLD_MIN),
);
const REALERT_MIN = Number(process.env.REALERT_MIN ?? "60");
const WATCH_RUNTIMES = (process.env.WATCH_RUNTIMES ?? "codex")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const CREWS_DB = process.env.CREWS_DB ?? `${process.env.HOME}/.wire/crews.db`;
const STATE_DIR = `${process.env.HOME}/.wire/codex-freeze-watchdog`;
const STATE_FILE = `${STATE_DIR}/state.json`;
const CAPTURE_FAIL_STATE_FILE = `${STATE_DIR}/capture-fails.json`;
const WORK_MARKER = new RegExp(process.env.WORK_MARKER ?? "working", "i");

/**
 * Strip everything that animates on a FROZEN codex TUI so identical
 * underlying frames hash identically:
 *   - digits: the Working elapsed counter, token counts, percentages
 *   - U+2500–257F box drawing: the ─── rules around the counter
 *   - U+2580–259F block elements: progress/scroll indicators
 *   - U+2800–28FF braille: spinner frames
 * Deliberately narrow — over-stripping would make genuinely different frames
 * collide and turn screen changes invisible (missed change = false alarm).
 */
export function normalizeFrame(text: string): string {
  return text
    .replace(/[0-9]/g, "")
    .replace(/[─-╿▀-▟⠀-⣿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function frameHash(text: string): string {
  return createHash("sha256").update(normalizeFrame(text)).digest("hex");
}

export type AgentSnapshot = {
  id: string;
  screen_name: string;
  hash: string;
  working: boolean;
};

export type WatchEntry = { hash: string; sinceMs: number; lastAlertMs: number };
export type WatchState = Record<string, WatchEntry>;
export type Alert = { id: string; screen_name: string; staticMins: number };

/**
 * Pure transition: previous state + current snapshots → next state + alerts.
 * Keyed by screen_name (a respawned agent gets a fresh screen → fresh entry);
 * screens absent from `snaps` are pruned by construction.
 */
export function decide(
  prev: WatchState,
  snaps: AgentSnapshot[],
  nowMs: number,
  cfg: { thresholdMin: number; realertMin: number },
): { state: WatchState; alerts: Alert[] } {
  const state: WatchState = {};
  const alerts: Alert[] = [];
  for (const s of snaps) {
    const p = prev[s.screen_name];
    if (!p || p.hash !== s.hash) {
      state[s.screen_name] = { hash: s.hash, sinceMs: nowMs, lastAlertMs: 0 };
      continue;
    }
    const entry: WatchEntry = { ...p };
    const staticMins = (nowMs - p.sinceMs) / 60_000;
    // lastAlertMs === 0 is the never-alerted sentinel — don't let it count
    // as "alerted at epoch" against the re-alert window.
    const sinceAlertMins = p.lastAlertMs === 0 ? Infinity : (nowMs - p.lastAlertMs) / 60_000;
    if (s.working && staticMins >= cfg.thresholdMin && sinceAlertMins >= cfg.realertMin) {
      alerts.push({ id: s.id, screen_name: s.screen_name, staticMins: Math.floor(staticMins) });
      entry.lastAlertMs = nowMs;
    }
    state[s.screen_name] = entry;
  }
  return { state, alerts };
}

export type CaptureFailEntry = { sinceMs: number; lastAlertMs: number };
export type CaptureFailState = Record<string, CaptureFailEntry>;
export type CaptureFailAlert = { id: string; screen_name: string; failingMins: number };

/**
 * Pure transition for the capture-failure alarm: previous failure state + the
 * agents that FAILED capture this run (each present in crews.db with a LIVE
 * screen_pid, i.e. "claimed alive but unreadable") → next state + alerts.
 * Mirrors decide(): keyed by screen_name, alerts once static past thresholdMin,
 * re-alerts no more than every realertMin, never-alerted sentinel is 0. An
 * agent that captures OK (or vanishes) is absent from `failing` and so pruned
 * by construction — a single good frame resets the streak (no sticky alarms).
 */
export function decideCaptureFailures(
  prev: CaptureFailState,
  failing: { id: string; screen_name: string }[],
  nowMs: number,
  cfg: { thresholdMin: number; realertMin: number },
): { state: CaptureFailState; alerts: CaptureFailAlert[] } {
  const state: CaptureFailState = {};
  const alerts: CaptureFailAlert[] = [];
  for (const f of failing) {
    const p = prev[f.screen_name];
    if (!p) {
      state[f.screen_name] = { sinceMs: nowMs, lastAlertMs: 0 };
      continue;
    }
    const entry: CaptureFailEntry = { ...p };
    const failingMins = (nowMs - p.sinceMs) / 60_000;
    const sinceAlertMins = p.lastAlertMs === 0 ? Infinity : (nowMs - p.lastAlertMs) / 60_000;
    if (failingMins >= cfg.thresholdMin && sinceAlertMins >= cfg.realertMin) {
      alerts.push({ id: f.id, screen_name: f.screen_name, failingMins: Math.floor(failingMins) });
      entry.lastAlertMs = nowMs;
    }
    state[f.screen_name] = entry;
  }
  return { state, alerts };
}

/** Last non-empty lines of the raw frame — the "what is it stuck on" context. */
export function tailExcerpt(raw: string, lines = 8, maxChars = 600): string {
  const tail = raw
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(-lines)
    .join("\n");
  return tail.length > maxChars ? `…${tail.slice(-maxChars)}` : tail;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hardcopy a screen session and return the frame. `screen -X hardcopy` is
 * ASYNC (queued to the screen server) — poll until the file exists and its
 * size settles, same fix crew-tools' readOutput uses (Brioche 2026-06-02).
 */
async function captureFrame(screenName: string): Promise<string> {
  const tmpFile = `/tmp/freeze-watchdog-${screenName}-${Date.now()}`;
  try {
    await $`screen -S ${screenName} -X hardcopy ${tmpFile}`.quiet();
    const deadline = Date.now() + 2000;
    let prev = -1;
    while (Date.now() < deadline) {
      let size: number;
      try {
        size = statSync(tmpFile).size;
      } catch {
        await new Promise((r) => setTimeout(r, 25));
        continue;
      }
      if (size === prev) break;
      prev = size;
      await new Promise((r) => setTimeout(r, 25));
    }
    const content = await Bun.file(tmpFile).text();
    return content;
  } finally {
    await $`rm -f ${tmpFile}`.quiet().nothrow();
  }
}

async function publishTopic(topic: string, payload: Record<string, unknown>): Promise<void> {
  const { privateKey } = await importKeyPair(
    process.env.AGENT_PRIVATE_KEY ??
      (() => {
        throw new Error("AGENT_PRIVATE_KEY required");
      })(),
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

async function main(): Promise<void> {
  const db = new Database(CREWS_DB, { readonly: true });
  const placeholders = WATCH_RUNTIMES.map(() => "?").join(",");
  const rows = db
    .query<{ id: string; screen_name: string; screen_pid: number | null }, string[]>(
      `SELECT id, screen_name, screen_pid FROM agents WHERE runtime IN (${placeholders})`,
    )
    .all(...WATCH_RUNTIMES);
  db.close();

  const snaps: AgentSnapshot[] = [];
  const tails: Record<string, string> = {};
  const captureFails: { id: string; screen_name: string }[] = [];
  for (const row of rows) {
    if (!row.screen_pid || !isAlive(row.screen_pid)) continue; // dead/stale row — lifecycle, not an error
    let raw: string;
    try {
      raw = await captureFrame(row.screen_name);
    } catch (e) {
      // screen_pid is ALIVE but hardcopy failed — NOT benign churn. This is the
      // codex freeze/death signature (the screen goes "(Remote or dead)" while
      // the row lingers in crews.db). Track it for the capture-failure alarm.
      console.error(`capture failed for ${row.screen_name} (alive pid ${row.screen_pid}): ${String(e)}`);
      captureFails.push({ id: row.id, screen_name: row.screen_name });
      continue;
    }
    tails[row.screen_name] = tailExcerpt(raw);
    snaps.push({
      id: row.id,
      screen_name: row.screen_name,
      hash: frameHash(raw),
      working: WORK_MARKER.test(raw),
    });
  }

  mkdirSync(STATE_DIR, { recursive: true });
  const now = Date.now();
  const stateFile = Bun.file(STATE_FILE);
  const prev: WatchState = (await stateFile.exists()) ? await stateFile.json() : {};
  const { state, alerts } = decide(prev, snaps, now, {
    thresholdMin: THRESHOLD_MIN,
    realertMin: REALERT_MIN,
  });

  const capStateFile = Bun.file(CAPTURE_FAIL_STATE_FILE);
  const capPrev: CaptureFailState = (await capStateFile.exists()) ? await capStateFile.json() : {};
  const { state: capState, alerts: capAlerts } = decideCaptureFailures(capPrev, captureFails, now, {
    thresholdMin: CAPTURE_FAIL_THRESHOLD_MIN,
    realertMin: REALERT_MIN,
  });

  const failures: string[] = [];
  for (const a of alerts) {
    try {
      await publishTopic("ipc", {
        from: AGENT_ID,
        re: "CODEX FREEZE SUSPECT",
        text:
          `Codex agent '${a.id}' (screen ${a.screen_name}) has shown a Working indicator with a ` +
          `static screen for ~${a.staticMins} min (threshold ${THRESHOLD_MIN}m).\n\n` +
          `Last screen lines:\n${tails[a.screen_name] ?? "(unavailable)"}\n\n` +
          `RUNBOOK (savarin-3344 ×2, 2026-06-12): agent_read('${a.id}') first. ` +
          `OPENING-turn stall (agent has never made a tool call, brief never processed) → go ` +
          `straight to recycle (stop + force_rotate respawn) — Esc just orphans the brief. ` +
          `MID-task stall → single Esc via agent_send → re-read; recycle only if that fails.\n` +
          `Known causes: (a) an MCP server that never finished starting blocks codex's tool-list ` +
          `assembly FOREVER (startup_timeout does not unblock it) — check the spawn's ` +
          `CODEX_HOME logs_*.sqlite for 'waiting for MCP server tools'; (b) model-stream stall ` +
          `(codex retries idle streams every 5m up to 5x); (c) a hung command in the PTY ` +
          `(codex never kills these — Esc interrupts the turn but the process may linger).\n\n` +
          `ALARM-ONLY: no action taken. Re-alerts at most every ${REALERT_MIN}m while static.`,
        agent_id: a.id,
        screen_name: a.screen_name,
        static_mins: a.staticMins,
      });
      console.log(`ALERT published for ${a.id} (${a.staticMins}m static)`);
    } catch (e) {
      failures.push(`${a.id}: ${String(e)}`);
      // Revert the alert stamp so the NEXT run retries delivery instead of
      // sitting out the re-alert window on an alert nobody received.
      const entry = state[a.screen_name];
      if (entry) entry.lastAlertMs = prev[a.screen_name]?.lastAlertMs ?? 0;
    }
  }
  for (const a of capAlerts) {
    try {
      await publishTopic("ipc", {
        from: AGENT_ID,
        re: "CODEX UNRESPONSIVE — screen uncapturable",
        text:
          `Codex agent '${a.id}' (screen ${a.screen_name}) is listed ALIVE in crews.db but its ` +
          `screen has been UNCAPTURABLE for ~${a.failingMins} min — \`screen -X hardcopy\` fails ` +
          `every run (threshold ${CAPTURE_FAIL_THRESHOLD_MIN}m).\n\n` +
          `This is the SILENT freeze/death signature that took financier, beignet and cannoli on ` +
          `2026-06-15: the codex screen goes "(Remote or dead)" while its row lingers in crews.db, so ` +
          `the frame-hash freeze check never gets a frame and the agent dies with no alarm.\n\n` +
          `RUNBOOK: crew agent_read('${a.id}') — if it errors or the screen is dead, the agent is ` +
          `wedged or orphaned: recycle it (stop + force_rotate respawn). Inspect the spawn's codex log ` +
          `at ~/.wire/codex-spawn/${a.id}/logs_*.sqlite — a 'turn' dispatched with no completion, or ` +
          `'waiting for MCP server tools', pinpoints the hang.\n\n` +
          `ALARM-ONLY: no action taken. Re-alerts at most every ${REALERT_MIN}m while uncapturable.`,
        agent_id: a.id,
        screen_name: a.screen_name,
        uncapturable_mins: a.failingMins,
      });
      console.log(`CAPTURE-FAIL ALERT published for ${a.id} (${a.failingMins}m uncapturable)`);
    } catch (e) {
      failures.push(`${a.id} (capture-fail): ${String(e)}`);
      // Revert the stamp so the next run retries delivery (mirror of above).
      const entry = capState[a.screen_name];
      if (entry) entry.lastAlertMs = capPrev[a.screen_name]?.lastAlertMs ?? 0;
    }
  }

  // State is written AFTER publish attempts so a delivery failure never
  // persists as "already alerted".
  await Bun.write(STATE_FILE, JSON.stringify(state, null, 2));
  await Bun.write(CAPTURE_FAIL_STATE_FILE, JSON.stringify(capState, null, 2));

  console.log(
    `[as ${AGENT_ID} → ${DEST}] watched ${snaps.length}/${rows.length} codex screen(s), ` +
      `${alerts.length + capAlerts.length} alert(s)` +
      (captureFails.length ? `, ${captureFails.length} uncapturable` : "") +
      (snaps.length ? ` [${snaps.map((s) => `${s.id}${s.working ? ":working" : ""}`).join(", ")}]` : ""),
  );
  if (failures.length) {
    throw new Error(`alert publish failed (stamp reverted, retries next run): ${failures.join("; ")}`);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    console.error(`freeze-watchdog run failed: ${String(e)}`);
    process.exit(2);
  }
}
