import { describe, expect, test } from "bun:test";
import { TurnGuard } from "./turn-guard.js";

const cfg = (maxTurnTokens: number, maxTurnSeconds: number) => ({ maxTurnTokens, maxTurnSeconds });

describe("TurnGuard", () => {
  test("enabled reflects whether either budget is positive", () => {
    expect(new TurnGuard(cfg(0, 0)).enabled).toBe(false);
    expect(new TurnGuard(cfg(100, 0)).enabled).toBe(true);
    expect(new TurnGuard(cfg(0, 60)).enabled).toBe(true);
  });

  test("no active turn → check returns null", () => {
    const g = new TurnGuard(cfg(1000, 60));
    expect(g.check(999_999, 999_999)).toBeNull();
  });

  test("token-delta breach fires once budget exceeded, measured from baseline", () => {
    const g = new TurnGuard(cfg(50_000, 0));
    g.start("turn-1", 0, 100_000); // baseline 100k cumulative
    expect(g.check(1_000, 120_000)).toBeNull(); // delta 20k < 50k
    const b = g.check(2_000, 151_000); // delta 51k >= 50k
    expect(b?.reason).toBe("tokens");
    expect(b?.turnId).toBe("turn-1");
    expect(b?.detail.delta).toBe(51_000);
  });

  test("time breach fires when wall-clock budget exceeded", () => {
    const g = new TurnGuard(cfg(0, 300));
    g.start("turn-1", 1_000, 0);
    expect(g.check(1_000 + 299_000, 10)).toBeNull(); // 299s < 300s
    const b = g.check(1_000 + 300_000, 10); // exactly 300s
    expect(b?.reason).toBe("time");
    expect(b?.detail.budgetMs).toBe(300_000);
  });

  test("breach is latched — reported once, then null until clear()", () => {
    const g = new TurnGuard(cfg(50_000, 0));
    g.start("turn-1", 0, 0);
    expect(g.check(1, 60_000)?.reason).toBe("tokens"); // first breach
    expect(g.check(2, 70_000)).toBeNull(); // latched — no repeat interrupt
    expect(g.check(3, 90_000)).toBeNull();
  });

  test("clear() re-arms for the next turn with a fresh baseline", () => {
    const g = new TurnGuard(cfg(50_000, 0));
    g.start("turn-1", 0, 0);
    expect(g.check(1, 60_000)?.reason).toBe("tokens");
    g.clear();
    expect(g.activeTurnId).toBeNull();
    expect(g.check(2, 999_999)).toBeNull(); // no active turn after clear
    g.start("turn-2", 0, 60_000); // next turn baselines at the carried-over cumulative
    expect(g.check(3, 90_000)).toBeNull(); // delta 30k < 50k → fresh turn unaffected by prior burn
    expect(g.check(4, 115_000)?.reason).toBe("tokens"); // delta 55k → breach
  });

  test("token budget disabled (<=0) ignores token growth; time still guards", () => {
    const g = new TurnGuard(cfg(0, 300));
    g.start("turn-1", 0, 0);
    expect(g.check(1, 10_000_000)).toBeNull(); // unbounded tokens allowed
    expect(g.check(300_000, 10_000_000)?.reason).toBe("time");
  });

  test("whichever budget trips first wins", () => {
    const g = new TurnGuard(cfg(50_000, 300));
    g.start("turn-1", 0, 0);
    // tokens cross first, before 300s
    expect(g.check(1_000, 51_000)?.reason).toBe("tokens");
  });
});
