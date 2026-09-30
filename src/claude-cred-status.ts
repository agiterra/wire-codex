/**
 * Claude credential classification + failure history for usage-telemetry.
 *
 * Pure functions (no I/O) so the wording can be tested. The rule this module
 * exists to keep: a status string reports what was OBSERVED, never a forecast.
 * One poll cannot tell a momentary blip from a persistent condition — only the
 * failure history can, so the history travels with every failure.
 */

export type CredBlob =
  | { kind: "ok"; token: string; expiresAt: number }
  | { kind: "absent" } // valid JSON, no claudeAiOauth.accessToken
  | { kind: "unparseable"; bytes: number }; // empty read or partial write

export function classifyCredBlob(raw: string): CredBlob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unparseable", bytes: raw.length };
  }
  const o = (parsed as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } } | null)?.claudeAiOauth;
  if (!o || typeof o.accessToken !== "string" || !o.accessToken) return { kind: "absent" };
  return { kind: "ok", token: o.accessToken, expiresAt: Number(o.expiresAt ?? 0) };
}

/** Human-readable status for one source. `mtimeIso` is appended when known. */
export function describeCred(blob: CredBlob, now: number, mtimeIso?: string | null): string {
  const at = mtimeIso ? `, last modified ${mtimeIso}` : "";
  switch (blob.kind) {
    case "unparseable":
      return `unparseable (${blob.bytes} bytes, not JSON: empty read or partial write${at})`;
    case "absent":
      return `no claudeAiOauth.accessToken (parsed OK: the stored credential holds no token${at})`;
    case "ok":
      if (blob.expiresAt && blob.expiresAt <= now) return `EXPIRED at ${new Date(blob.expiresAt).toISOString()}${at}`;
      return blob.expiresAt ? `ok (expires ${new Date(blob.expiresAt).toISOString()})` : "ok (access-token-only, no expiry)";
  }
}

export type ClaudeHistory = {
  counter_since: string; // when this counter started (no success is known before it)
  last_ok_at: string | null;
  consecutive_failures: number;
};

export function nextHistory(prev: ClaudeHistory | null, ok: boolean, nowIso: string): ClaudeHistory {
  const base = prev ?? { counter_since: nowIso, last_ok_at: null, consecutive_failures: 0 };
  return ok
    ? { ...base, last_ok_at: nowIso, consecutive_failures: 0 }
    : { ...base, consecutive_failures: base.consecutive_failures + 1 };
}

export function historyLine(h: ClaudeHistory | null): string {
  if (!h) return "failure history UNKNOWN (history file unreadable)";
  const last = h.last_ok_at ? `last ok ${h.last_ok_at}` : `no success recorded since counter start ${h.counter_since}`;
  return `${h.consecutive_failures} consecutive failed poll(s); ${last}`;
}

export function noTokenMessage(diag: string, h: ClaudeHistory | null): string {
  return (
    `no usable Claude accessToken after retries — ${diag}. ${historyLine(h)}. ` +
    `(A single poll cannot tell a momentary blip from a persistent condition; the history above is the evidence. ` +
    `EXPIRED-at = the stored token is past expiry: a running Claude Code refreshes the keychain copy, otherwise an operator re-login.)`
  );
}

// ── Per-host opt-out (USAGE_TELEMETRY_CLAUDE=off) ─────────────────────────────
// Chariot has had no Claude login since 2026-06-09, so every hourly run published
// status=failed for a probe nobody uses (Brioche 644921 approved the opt-out). "off"
// skips the poll; the Claude block then says NOT COLLECTED with null usage. It must
// never look like a measured 0% or a healthy reading.

export type ClaudeSwitch = { mode: "on" } | { mode: "off" } | { mode: "invalid"; raw: string };

/** Unset/""/"on" collect; "off" skips (case-insensitive). Anything else is invalid: collect AND report it. */
export function parseClaudeSwitch(raw: string | undefined): ClaudeSwitch {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "on") return { mode: "on" };
  if (v === "off") return { mode: "off" };
  return { mode: "invalid", raw: raw as string };
}

export const NOT_COLLECTED_REASON = "disabled on this host (USAGE_TELEMETRY_CLAUDE=off)";

/**
 * Machine-readable Claude block while disabled. Every usage window is null. The failure
 * history is carried as it stood when polling stopped (`history_frozen`), so it stays
 * attributable as history. It is not advanced, and it is not a current failure.
 */
export function notCollectedBlock(history: ClaudeHistory | null | "unreadable") {
  return {
    state: "not_collected" as const,
    reason: NOT_COLLECTED_REASON,
    five_hour: null,
    seven_day: null,
    seven_day_sonnet: null,
    seven_day_opus: null,
    history_frozen: history === "unreadable" ? "unreadable" : history,
  };
}

/**
 * One-time notice bookkeeping from a marker file. off + no marker → notify (then write marker);
 * off + marker → skip; on + marker → clear (so a later opt-out notifies again); on + none → nothing.
 */
export function noticeAction(off: boolean, markerExists: boolean): "notify" | "skip" | "clear" | "none" {
  if (off) return markerExists ? "skip" : "notify";
  return markerExists ? "clear" : "none";
}
