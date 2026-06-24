/**
 * TurnGuard — bounds a SINGLE runaway codex turn.
 *
 * The recycle path (index.ts onTokenUsage → thread/compact/start) watches
 * CUMULATIVE thread tokens and fires BETWEEN turns, so it structurally cannot
 * catch one turn ballooning in-flight. Observed 2026-06-24: a bare agent spun
 * 26k→123k tokens in a single uncompleted turn. codex does not bound a turn on
 * its own, so we do it externally: when a turn's own token delta or wall-clock
 * exceeds budget, the caller issues `turn/interrupt {threadId, turnId}`.
 *
 * Pure state machine — no I/O, no clock of its own (the caller passes `nowMs`)
 * — so the breach semantics are unit-testable without an app-server, exactly
 * like TurnGate.
 */

export type GuardReason = "tokens" | "time";

export type GuardBreach = {
  reason: GuardReason;
  turnId: string;
  /** Numbers behind the decision, for the interrupt log line. */
  detail: Record<string, number>;
};

export type TurnGuardConfig = {
  /** Per-turn token-delta budget (current cumulative − cumulative at turn start). <=0 disables. */
  maxTurnTokens: number;
  /** Wall-clock budget for one turn, in seconds. <=0 disables. */
  maxTurnSeconds: number;
};

export class TurnGuard {
  private cfg: TurnGuardConfig;
  private turnId: string | null = null;
  private startedAtMs = 0;
  private baselineTokens = 0;
  /** Latch: a breach is reported exactly ONCE per turn so the caller issues a single interrupt. */
  private tripped = false;

  constructor(cfg: TurnGuardConfig) {
    this.cfg = cfg;
  }

  get enabled(): boolean {
    return this.cfg.maxTurnTokens > 0 || this.cfg.maxTurnSeconds > 0;
  }

  get activeTurnId(): string | null {
    return this.turnId;
  }

  /**
   * Begin tracking a turn. `baselineTokens` is the cumulative thread-token
   * total observed just before this turn (so the per-turn delta starts at 0).
   */
  start(turnId: string, nowMs: number, baselineTokens: number): void {
    this.turnId = turnId;
    this.startedAtMs = nowMs;
    this.baselineTokens = baselineTokens;
    this.tripped = false;
  }

  /** The active turn ended (completed, aborted, or failed). */
  clear(): void {
    this.turnId = null;
    this.tripped = false;
  }

  /**
   * Evaluate the active turn against the budgets. Returns a breach the FIRST
   * time a budget is exceeded (then latches to null until clear()), so a
   * caller polling on every token update + a timer issues only one interrupt.
   * Returns null when there is no active turn, the guard is disabled, the turn
   * is within budget, or a breach was already reported.
   */
  check(nowMs: number, currentTotalTokens: number): GuardBreach | null {
    if (this.turnId === null || this.tripped) return null;

    const { maxTurnTokens, maxTurnSeconds } = this.cfg;

    if (maxTurnTokens > 0) {
      const delta = currentTotalTokens - this.baselineTokens;
      if (delta >= maxTurnTokens) {
        this.tripped = true;
        return { reason: "tokens", turnId: this.turnId, detail: { delta, budget: maxTurnTokens } };
      }
    }

    if (maxTurnSeconds > 0) {
      const elapsedMs = nowMs - this.startedAtMs;
      if (elapsedMs >= maxTurnSeconds * 1000) {
        this.tripped = true;
        return { reason: "time", turnId: this.turnId, detail: { elapsedMs, budgetMs: maxTurnSeconds * 1000 } };
      }
    }

    return null;
  }
}
