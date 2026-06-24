import { describe, expect, test } from "bun:test";
import {
  decide,
  decideCaptureFailures,
  frameHash,
  normalizeFrame,
  tailExcerpt,
  type WatchState,
} from "./freeze-watchdog";

// Two captures of the SAME frozen codex TUI frame: only the elapsed counter,
// spinner glyph, and token count differ — exactly what animates while a hung
// tool call sits in a PTY.
const FROZEN_T0 = `
• Running gh pr view https://github.com/fabrica-land/fabrica-v3/pull/1101 --json state

⠋ Working ─── 312s ─── Esc to interrupt
tokens used: 41,203   context left: 62%
`;
const FROZEN_T1 = `
• Running gh pr view https://github.com/fabrica-land/fabrica-v3/pull/1101 --json state

⠙ Working ─── 617s ─── Esc to interrupt
tokens used: 41,203   context left: 62%
`;
const PROGRESSED = `
• Ran gh pr view — exit 0
• Editing src/api/routes.ts

⠹ Working ─── 12s ─── Esc to interrupt
tokens used: 44,890   context left: 60%
`;
const IDLE = `
▌ Ready for your next message
›
`;

const CFG = { thresholdMin: 15, realertMin: 60 };
const MIN = 60_000;

describe("normalizeFrame", () => {
  test("frozen frames differing only in counter/spinner hash identically", () => {
    expect(frameHash(FROZEN_T0)).toBe(frameHash(FROZEN_T1));
  });

  test("real progress changes the hash", () => {
    expect(frameHash(FROZEN_T0)).not.toBe(frameHash(PROGRESSED));
  });

  test("strips digits, box drawing, blocks, braille; collapses whitespace", () => {
    expect(normalizeFrame("⠋ Working ─── 312s ───")).toBe("Working s");
    expect(normalizeFrame("▌ 100% │ done")).toBe("% done");
  });
});

describe("decide", () => {
  const snap = (over: Partial<Parameters<typeof decide>[1][number]> = {}) => ({
    id: "praline-3339",
    screen_name: "praline-3339",
    hash: frameHash(FROZEN_T0),
    working: true,
    ...over,
  });

  test("first sighting arms but never alerts", () => {
    const { state, alerts } = decide({}, [snap()], 0, CFG);
    expect(alerts).toEqual([]);
    expect(state["praline-3339"]).toEqual({ hash: frameHash(FROZEN_T0), sinceMs: 0, lastAlertMs: 0 });
  });

  test("static below threshold stays quiet", () => {
    const { state } = decide({}, [snap()], 0, CFG);
    const { alerts } = decide(state, [snap()], 14 * MIN, CFG);
    expect(alerts).toEqual([]);
  });

  test("static at threshold while working alerts once and stamps lastAlertMs", () => {
    const { state } = decide({}, [snap()], 0, CFG);
    const { state: s2, alerts } = decide(state, [snap()], 15 * MIN, CFG);
    expect(alerts).toEqual([{ id: "praline-3339", screen_name: "praline-3339", staticMins: 15 }]);
    expect(s2["praline-3339"].lastAlertMs).toBe(15 * MIN);
    expect(s2["praline-3339"].sinceMs).toBe(0); // since is NOT reset by alerting
  });

  test("re-alert suppressed inside realert window, fires after it", () => {
    const armed = decide({}, [snap()], 0, CFG).state;
    const alerted = decide(armed, [snap()], 15 * MIN, CFG).state;
    expect(decide(alerted, [snap()], 30 * MIN, CFG).alerts).toEqual([]);
    const again = decide(alerted, [snap()], 75 * MIN, CFG);
    expect(again.alerts.length).toBe(1);
    expect(again.alerts[0].staticMins).toBe(75);
  });

  test("static but NOT working (idle prompt) never alerts", () => {
    const idle = snap({ hash: frameHash(IDLE), working: false });
    const { state } = decide({}, [idle], 0, CFG);
    const { alerts } = decide(state, [idle], 120 * MIN, CFG);
    expect(alerts).toEqual([]);
  });

  test("hash change resets the static clock and the alert stamp", () => {
    const armed = decide({}, [snap()], 0, CFG).state;
    const alerted = decide(armed, [snap()], 15 * MIN, CFG).state;
    const progressed = decide(alerted, [snap({ hash: frameHash(PROGRESSED) })], 16 * MIN, CFG);
    expect(progressed.alerts).toEqual([]);
    expect(progressed.state["praline-3339"]).toEqual({
      hash: frameHash(PROGRESSED),
      sinceMs: 16 * MIN,
      lastAlertMs: 0,
    });
  });

  test("vanished screens are pruned; respawn under a new screen starts fresh", () => {
    const prev: WatchState = {
      "praline-3339": { hash: "x", sinceMs: 0, lastAlertMs: 0 },
      "stollen-2901": { hash: "y", sinceMs: 0, lastAlertMs: 0 },
    };
    const { state } = decide(prev, [snap({ screen_name: "praline-3339b" })], 20 * MIN, CFG);
    expect(Object.keys(state)).toEqual(["praline-3339b"]);
    expect(state["praline-3339b"].sinceMs).toBe(20 * MIN);
  });
});

describe("decideCaptureFailures", () => {
  // A crews.db-live codex agent whose screen hardcopy keeps failing — the
  // financier/beignet/cannoli signature the watchdog used to skip silently.
  const fail = (over: { id?: string; screen_name?: string } = {}) => ({
    id: "financier",
    screen_name: "wire-financier",
    ...over,
  });

  test("first capture-failure arms but never alerts", () => {
    const { state, alerts } = decideCaptureFailures({}, [fail()], 0, CFG);
    expect(alerts).toEqual([]);
    expect(state["wire-financier"]).toEqual({ sinceMs: 0, lastAlertMs: 0 });
  });

  test("uncapturable below threshold stays quiet", () => {
    const { state } = decideCaptureFailures({}, [fail()], 0, CFG);
    const { alerts } = decideCaptureFailures(state, [fail()], 14 * MIN, CFG);
    expect(alerts).toEqual([]);
  });

  test("uncapturable at threshold alerts once and stamps lastAlertMs", () => {
    const { state } = decideCaptureFailures({}, [fail()], 0, CFG);
    const { state: s2, alerts } = decideCaptureFailures(state, [fail()], 15 * MIN, CFG);
    expect(alerts).toEqual([{ id: "financier", screen_name: "wire-financier", failingMins: 15 }]);
    expect(s2["wire-financier"].lastAlertMs).toBe(15 * MIN);
    expect(s2["wire-financier"].sinceMs).toBe(0); // since is NOT reset by alerting
  });

  test("re-alert suppressed inside realert window, fires after it", () => {
    const armed = decideCaptureFailures({}, [fail()], 0, CFG).state;
    const alerted = decideCaptureFailures(armed, [fail()], 15 * MIN, CFG).state;
    expect(decideCaptureFailures(alerted, [fail()], 30 * MIN, CFG).alerts).toEqual([]);
    const again = decideCaptureFailures(alerted, [fail()], 75 * MIN, CFG);
    expect(again.alerts.length).toBe(1);
    expect(again.alerts[0].failingMins).toBe(75);
  });

  test("a successful capture (absent from failing) resets the streak", () => {
    const armed = decideCaptureFailures({}, [fail()], 0, CFG).state;
    const recovered = decideCaptureFailures(armed, [], 10 * MIN, CFG); // captured OK → pruned
    expect(recovered.state).toEqual({});
    const rearmed = decideCaptureFailures(recovered.state, [fail()], 12 * MIN, CFG);
    expect(rearmed.alerts).toEqual([]); // clock restarted, no early alert
    expect(rearmed.state["wire-financier"].sinceMs).toBe(12 * MIN);
  });

  test("vanished screens are pruned", () => {
    const prev = {
      "wire-financier": { sinceMs: 0, lastAlertMs: 0 },
      "wire-old": { sinceMs: 0, lastAlertMs: 0 },
    };
    const { state } = decideCaptureFailures(prev, [fail()], 20 * MIN, CFG);
    expect(Object.keys(state)).toEqual(["wire-financier"]);
  });
});

describe("tailExcerpt", () => {
  test("keeps the last non-empty lines, capped", () => {
    const raw = `line1\n\n\nline2\n   \nline3\n`;
    expect(tailExcerpt(raw, 2)).toBe("line2\nline3");
    const long = Array.from({ length: 20 }, (_, i) => `row ${i} ${"x".repeat(80)}`).join("\n");
    expect(tailExcerpt(long, 8, 100).length).toBeLessThanOrEqual(101); // … + 100
    expect(tailExcerpt(long, 8, 100).startsWith("…")).toBe(true);
  });
});
