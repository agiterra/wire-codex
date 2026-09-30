import { describe, expect, test } from "bun:test";
import { classifyCredBlob, describeCred, historyLine, nextHistory, noTokenMessage, noticeAction, notCollectedBlock, parseClaudeSwitch } from "./claude-cred-status";

const NOW = Date.parse("2026-09-29T21:22:27Z");

describe("classifyCredBlob", () => {
  test("empty read is unparseable, not absent", () => {
    expect(classifyCredBlob("")).toEqual({ kind: "unparseable", bytes: 0 });
  });
  test("truncated JSON is unparseable", () => {
    expect(classifyCredBlob('{"claudeAiOauth":{"acc').kind).toBe("unparseable");
  });
  test("valid JSON with an empty claudeAiOauth is absent", () => {
    expect(classifyCredBlob('{"claudeAiOauth":{}}')).toEqual({ kind: "absent" });
  });
  test("valid JSON with no claudeAiOauth is absent", () => {
    expect(classifyCredBlob("{}")).toEqual({ kind: "absent" });
  });
  test("token + expiry is ok", () => {
    expect(classifyCredBlob('{"claudeAiOauth":{"accessToken":"t","expiresAt":5}}')).toEqual({ kind: "ok", token: "t", expiresAt: 5 });
  });
});

describe("describeCred", () => {
  test("absent says parsed OK and carries the mtime", () => {
    const s = describeCred({ kind: "absent" }, NOW, "2026-06-09T19:32:00.000Z");
    expect(s).toContain("parsed OK");
    expect(s).toContain("last modified 2026-06-09T19:32:00.000Z");
    expect(s).not.toContain("mid-rewrite");
  });
  test("expired token reports its expiry", () => {
    expect(describeCred({ kind: "ok", token: "t", expiresAt: NOW - 1000 }, NOW)).toStartWith("EXPIRED at 2026-09-29T21:22:26");
  });
  test("a status never carries the token", () => {
    expect(describeCred({ kind: "ok", token: "SECRET", expiresAt: NOW + 1000 }, NOW)).not.toContain("SECRET");
  });
});

describe("history", () => {
  test("fresh counter: first failure has no success", () => {
    const h = nextHistory(null, false, "2026-09-29T21:22:27Z");
    expect(h).toEqual({ counter_since: "2026-09-29T21:22:27Z", last_ok_at: null, consecutive_failures: 1 });
    expect(historyLine(h)).toBe("1 consecutive failed poll(s); no success recorded since counter start 2026-09-29T21:22:27Z");
  });
  test("failures accumulate and success resets", () => {
    let h = nextHistory(null, true, "t0");
    h = nextHistory(h, false, "t1");
    h = nextHistory(h, false, "t2");
    expect(h.consecutive_failures).toBe(2);
    expect(historyLine(h)).toBe("2 consecutive failed poll(s); last ok t0");
    h = nextHistory(h, true, "t3");
    expect(h).toEqual({ counter_since: "t0", last_ok_at: "t3", consecutive_failures: 0 });
  });
  test("unreadable history is UNKNOWN, not zero", () => {
    expect(historyLine(null)).toContain("UNKNOWN");
  });
});

describe("noTokenMessage", () => {
  test("makes no recovery forecast", () => {
    const m = noTokenMessage("keychain: x; file: y", nextHistory(null, false, "t"));
    expect(m).not.toMatch(/TRANSIENT|recovers next poll/i);
    expect(m).toContain("1 consecutive failed poll(s)");
    expect(m).toContain("cannot tell a momentary blip from a persistent condition");
  });
});

describe("Claude opt-out", () => {
  test("switch: unset/empty/on collect, off skips, anything else invalid", () => {
    expect(parseClaudeSwitch(undefined)).toEqual({ mode: "on" });
    expect(parseClaudeSwitch("")).toEqual({ mode: "on" });
    expect(parseClaudeSwitch("on")).toEqual({ mode: "on" });
    expect(parseClaudeSwitch("off")).toEqual({ mode: "off" });
    expect(parseClaudeSwitch(" OFF ")).toEqual({ mode: "off" });
    expect(parseClaudeSwitch("0")).toEqual({ mode: "invalid", raw: "0" });
    expect(parseClaudeSwitch("false")).toEqual({ mode: "invalid", raw: "false" });
  });
  test("not-collected block: every window null, never a number; history carried frozen", () => {
    const h = { counter_since: "2026-09-29T21:36:18.602Z", last_ok_at: null, consecutive_failures: 7 };
    const b = notCollectedBlock(h);
    expect(b.state).toBe("not_collected");
    for (const k of ["five_hour", "seven_day", "seven_day_sonnet", "seven_day_opus"] as const) expect(b[k]).toBeNull();
    expect(b.history_frozen).toEqual(h);
    expect(notCollectedBlock("unreadable").history_frozen).toBe("unreadable");
    expect(notCollectedBlock(null).history_frozen).toBeNull();
  });
  test("notice fires once per opt-out", () => {
    expect(noticeAction(true, false)).toBe("notify");
    expect(noticeAction(true, true)).toBe("skip");
    expect(noticeAction(false, true)).toBe("clear");
    expect(noticeAction(false, false)).toBe("none");
  });
});
