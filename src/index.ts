#!/usr/bin/env -S npx tsx
/**
 * wire-codex agent runtime — ONE codex app-server PROCESS per agent.
 *
 * (Tim's call 2026-06-24: not a shared daemon. Per-process env = the agent's
 * identity, so the spawned process's own CODEX_HOME/config.toml carries this
 * agent's wire-ipc MCP key for OUTBOUND, while we drive INBOUND here.)
 *
 * ONE process, ONE Wire connection per agent. This process:
 *   1. spawns `codex app-server --listen unix://<sock>` with the agent's
 *      provisioned CODEX_HOME (CodexAgentServer),
 *   2. holds the agent's single Wire SSE (wire-tools WireConnection —
 *      heartbeats, reconnect, frozen-worker watchdog included),
 *   3. hosts the `wire` MCP (set_plan/heartbeat/register) over StreamableHTTP
 *      on WIRE_MCP_PORT, sharing that one connection's identity; the codex
 *      agent dials it by URL (config.toml [mcp_servers.wire]) — no second SSE,
 *   4. turns inbound channel events into `turn/start` injections, batched
 *      through the gate (one active turn per thread),
 *   5. RECYCLES before context-death: watches `thread/tokenUsage/updated` and
 *      calls `thread/compact/start` past a threshold (codex has no auto-compact;
 *      at the limit it saves-and-dies — this prevents that),
 *   6. GUARDS against a single runaway turn: if one turn's own token-delta or
 *      wall-clock exceeds budget, issues `turn/interrupt` (recycle is cumulative
 *      + between-turns, so it cannot catch one ballooning turn),
 *   7. cleans up its app-server process on graceful close (Brioche reaps
 *      stale/crashed ones).
 *
 * Operator view is on-demand and external: `codex --remote unix://<sock>` in a
 * screen attaches a TUI to this same process. Outbound stays the agent's
 * wire-ipc MCP (in its CODEX_HOME config), unchanged.
 *
 * Env (identity flows exactly like a crew spawn):
 *   AGENT_ID            required — Wire agent id (and thread owner)
 *   AGENT_PRIVATE_KEY   required — base64 PKCS8 Ed25519
 *   WIRE_URL            required — gateway base URL
 *   PROJECT_DIR         required — cwd for the codex thread
 *   AGENT_NAME          optional — display name (defaults to AGENT_ID)
 *   CODEX_HOME          optional — provisioned per-agent home (default ~/.wire/codex-spawn/<id>)
 *   SOCKET_PATH         optional — app-server unix socket (default <CODEX_HOME>/app-server.sock; MUST be a real path, not /tmp)
 *   INITIAL_PROMPT      optional — first turn (role/task brief), sent through the gate
 *   STATE_DIR           optional — threadId persistence (default ~/.wire/codex-spawn)
 *   WIRE_MCP_PORT       optional — localhost port to host the `wire` MCP (StreamableHTTP) for the codex agent; unset = not hosted
 *   CONTEXT_WINDOW_TOKENS  optional — model context window for recycle math (default 1000000; gpt-5.5 = 1M)
 *   RECYCLE_AT_PERCENT     optional — recycle threshold percent (default 80)
 *   MAX_TURN_TOKENS        optional — per-turn token-delta budget (default 0 = OFF; the per-turn guard is misguided, see below — set >0 only to deliberately re-arm)
 *   MAX_TURN_SECONDS       optional — per-turn wall-clock budget in seconds (default 0 = OFF; same)
 */

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createServer as createHttpServer, type Server as HttpServer } from "http";
import { randomUUID } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { WireConnection } from "@agiterra/wire-tools/connection";
import { importKeyPair, type KeyPair } from "@agiterra/wire-tools/crypto";
import { createWebhookChannelHandler, createWireMcpServer } from "@agiterra/wire-tools";
import { CodexAgentServer } from "./agent-server.js";
import { TurnGate, formatBatch, type QueuedEvent } from "./gate.js";
import { TurnGuard } from "./turn-guard.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[wire-codex] fatal: ${name} env var required`);
    process.exit(1);
  }
  return v;
}

const agentId = requireEnv("AGENT_ID");
const agentName = process.env.AGENT_NAME ?? agentId;
const wireUrl = requireEnv("WIRE_URL");
const projectDir = requireEnv("PROJECT_DIR");
const home = process.env.HOME ?? "/tmp";
const codexHome = process.env.CODEX_HOME ?? join(home, ".wire", "codex-spawn", agentId);
const socketPath = process.env.SOCKET_PATH ?? join(codexHome, "app-server.sock");
const stateDir = process.env.STATE_DIR ?? join(home, ".wire", "codex-spawn");
const statePath = join(stateDir, `${agentId}.thread.json`);

const CONTEXT_WINDOW = Number(process.env.CONTEXT_WINDOW_TOKENS ?? "1000000"); // gpt-5.5: 1M
const RECYCLE_PERCENT = Number(process.env.RECYCLE_AT_PERCENT ?? "80");
const recycleThreshold = Math.floor((CONTEXT_WINDOW * RECYCLE_PERCENT) / 100);

// Per-turn runaway guard — DISABLED BY DEFAULT (2026-06-25, Tim's call: the
// whole idea is misguided). Both budgets default to 0 = off; the guard never
// issues turn/interrupt unless an operator deliberately re-arms it via env.
//
// Why it's gone: there is no honest discriminator for "a SINGLE turn is a
// runaway" via an external hard-interrupt.
//   - TOKENS can't work: a turn's token-DELTA and the thread's CUMULATIVE total
//     are nearly the same magnitude (a heavy turn fills most of the context in
//     one shot). Two miscalibrations proved it — 250k false-interrupted ~268k
//     initial turns; 600k STILL false-interrupted legit turns (strudel 605k,
//     kolache 640k, profiterole 650k delta, all real work). Legit deltas (650k)
//     run right up against recycle (80% of 1M = 800k), so no "above-legit yet
//     below-recycle" band exists. The original runaway it targeted (123k in an
//     EMPTY dir, no tools) is a test artifact, SMALLER than a normal turn.
//   - TIME can't work either: an agent doing great work for 20+ minutes is NOT
//     a runaway. A wall-clock interrupt punishes exactly the deep turns we want.
// Either way the false interrupt drops the agent into codex's placeholder-prompt
// wedge (22-32 min idle) — the cure is worse than the disease. The real backstop
// for context is recycle (cumulative, codex-native compact, no hard interrupt).
const MAX_TURN_TOKENS = Number(process.env.MAX_TURN_TOKENS ?? "0");
const MAX_TURN_SECONDS = Number(process.env.MAX_TURN_SECONDS ?? "0");

// Localhost port to host the agent's `wire` MCP over StreamableHTTP. The
// launcher assigns it and writes the matching url into config.toml. 0 = skip.
const MCP_PORT = Number(process.env.WIRE_MCP_PORT ?? "0");

function log(level: string, msg: string, fields?: Record<string, unknown>) {
  console.error(JSON.stringify({ t: new Date().toISOString(), level, name: "wire-codex", agent: agentId, msg, ...fields }));
}

function readState(): { threadId: string } | null {
  try { return JSON.parse(readFileSync(statePath, "utf8")); } catch { return null; }
}
function writeState(threadId: string): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify({ threadId, agentId, projectDir, updatedAt: new Date().toISOString() }) + "\n");
}

const gate = new TurnGate();
const guard = new TurnGuard({ maxTurnTokens: MAX_TURN_TOKENS, maxTurnSeconds: MAX_TURN_SECONDS });
let threadId = "";
let conn: WireConnection | null = null;
let wireMcpHttp: HttpServer | null = null;
let lastTotalTokens = 0; // most recent cumulative thread-token total (guard baseline + check input)

// System topics that must never become model turns (pure plan-token burn).
const SKIP_TOPICS = new Set(["wire.keepalive", "wire.connection_state"]);

// --- recycle-before-context-death ---
// codex has no auto-compact; at the context limit it saves-and-dies. We watch
// per-turn token usage and trigger codex's NATIVE compaction before the cliff.
let recycling = false;
function onTokenUsage(params: Record<string, unknown>): void {
  const usage = params?.tokenUsage as { total?: { totalTokens?: number }; totalTokens?: number } | undefined;
  const total = usage?.total?.totalTokens ?? usage?.totalTokens;
  if (typeof total !== "number") return;
  lastTotalTokens = total;
  const pct = Math.round((total / CONTEXT_WINDOW) * 100);
  log("info", "token usage", { total, pct, threshold: recycleThreshold });
  enforceGuard(Date.now());
  // Hysteresis: re-arm once we're comfortably back under (post-compaction).
  if (recycling && total < recycleThreshold * 0.85) recycling = false;
  if (total >= recycleThreshold && !recycling && !gate.busy) {
    recycling = true;
    log("warn", "recycle: context near limit — compacting", { total, pct });
    // NOTE: thread/compact/start exists in the live 0.140 method enum but its
    // exact semantics (blocking? own completion event?) are not yet validated —
    // dogfood. The one-turn-per-thread guard + pump requeue cover the race; a
    // safety timer clears the flag if no token drop follows.
    appServer.request("thread/compact/start", { threadId })
      .then(() => log("info", "compaction requested"))
      .catch((e) => { log("error", "compaction failed", { err: String(e) }); recycling = false; });
    setTimeout(() => { if (recycling) { log("warn", "recycle flag cleared (timeout)"); recycling = false; } }, 120_000);
  }
}

// --- per-turn runaway guard ---
// Interrupt a turn whose own token-delta or wall-clock exceeds budget. Driven
// by token updates AND a periodic watchdog (a wedged turn may emit no token
// updates, so the time budget needs an independent tick). The guard latches —
// one interrupt per turn — and clears on turn/completed. After interrupt, codex
// emits turn/completed(aborted) which releases the gate via the normal path.
function enforceGuard(nowMs: number): void {
  const breach = guard.check(nowMs, lastTotalTokens);
  if (!breach) return;
  log("error", "turn-guard: interrupting runaway turn", { reason: breach.reason, turnId: breach.turnId, ...breach.detail });
  appServer.interruptTurn(threadId, breach.turnId)
    .then(() => log("warn", "turn-guard: interrupt sent — awaiting turn/completed(aborted)"))
    .catch((e) => log("error", "turn-guard: interrupt failed", { err: String(e) }));
}

const appServer = new CodexAgentServer({
  socketPath,
  codexHome,
  cwd: projectDir,
  log: (level, msg, fields) => log(level, msg, fields),
  onNotification: (method, params) => {
    if (method === "turn/completed") {
      log("info", "turn completed", { status: (params as { turn?: { status?: string } }).turn?.status });
      guard.clear();
      if (gate.complete()) void pump();
    } else if (method === "thread/tokenUsage/updated") {
      onTokenUsage(params);
    }
  },
});

async function pump(): Promise<void> {
  const batch = gate.take();
  if (!batch) return;
  const text = formatBatch(batch);
  log("info", "injecting turn", { events: batch.length, pending: gate.pending });
  try {
    const turnId = await appServer.startTurn(threadId, text);
    if (turnId) guard.start(turnId, Date.now(), lastTotalTokens);
    else log("warn", "turn/start returned no turnId — turn-guard inactive for this turn");
  } catch (e) {
    // turn/start refused (race with an active turn / compaction): re-mark idle
    // so the next completion or event retries; never drop the batch silently.
    log("error", "turn/start failed — requeueing batch", { err: String(e) });
    gate.complete();
    for (const ev of batch) gate.push(ev);
  }
}

let shuttingDown = false;
function shutdown(sig: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "shutting down — killing app-server", { sig });
  try { appServer.close(); } catch (e) { log("error", "appServer.close failed", { err: String(e) }); }
  try { wireMcpHttp?.close(); } catch (e) { log("error", "wireMcpHttp.close failed", { err: String(e) }); }
  try { void conn?.stop(); } catch (e) { log("error", "conn.stop failed", { err: String(e) }); }
  setTimeout(() => process.exit(0), 200);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Host the agent's `wire` MCP (set_plan/heartbeat/register) over StreamableHTTP
// on 127.0.0.1:MCP_PORT, sharing THIS process's single Wire identity. inbound:
// 'none' — inbound Wire arrives as app-server turn injection, not via the MCP,
// so the wire MCP opens no SSE of its own. A single transport/session backs the
// one local codex client.
async function startWireMcp(keyPair: KeyPair): Promise<void> {
  if (!MCP_PORT) {
    log("warn", "WIRE_MCP_PORT unset — wire MCP not hosted (set_plan/heartbeat unavailable to the agent)");
    return;
  }
  const { server } = createWireMcpServer({ agentId, agentName, wireUrl, keyPair, inbound: "none" });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await server.connect(transport);
  wireMcpHttp = createHttpServer((req, res) => {
    if (req.url && req.url.startsWith("/mcp")) {
      transport.handleRequest(req, res).catch((e) => {
        log("error", "wire MCP request failed", { err: String(e) });
        if (!res.headersSent) { res.writeHead(500); res.end(); }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    wireMcpHttp!.once("error", reject);
    wireMcpHttp!.listen(MCP_PORT, "127.0.0.1", () => resolve());
  });
  log("info", "wire MCP listening", { url: `http://127.0.0.1:${MCP_PORT}/mcp`, inbound: "none" });
}

async function main(): Promise<void> {
  const keyPair = await importKeyPair(requireEnv("AGENT_PRIVATE_KEY"));

  // Bring the wire MCP endpoint up BEFORE the app-server, so it is already
  // listening when the codex agent connects its configured MCP clients.
  await startWireMcp(keyPair);

  const { userAgent } = await appServer.start();
  const prior = readState();
  const t = await appServer.ensureThread(prior?.threadId ?? null);
  threadId = t.threadId;
  writeState(threadId);

  conn = new WireConnection({
    url: wireUrl,
    agentId,
    agentName,
    keyPair,
    deliver: async ({ raw, channel }) => {
      if (SKIP_TOPICS.has(raw.topic)) return;
      const ev: QueuedEvent = { text: channel.text, topic: raw.topic, source: raw.source, seq: raw.seq };
      if (gate.push(ev)) void pump();
      else log("info", "event queued (turn in flight)", { pending: gate.pending, topic: ev.topic });
    },
    onConnect: (sessionId) => log("info", "wire connected", { sessionId }),
    onDisconnect: () => log("warn", "wire disconnected — reconnecting"),
    onError: (e) => log("error", "wire error", { err: String(e) }),
  });
  // IPC arrives webhook-wrapped (full envelope incl. auth headers); the handler
  // extracts just the user-visible text so the injected turn is clean + safe.
  conn.registerChannel("ipc", createWebhookChannelHandler());
  // wire-tools retries startup forever (silently from here — its log goes to
  // ~/.wire/wire-connection.jsonl). Race connect against a loud periodic warning
  // so a stuck startup (e.g. a 409 registration loop) is visible HERE.
  const started = conn.start();
  let connected = false;
  void started.then(() => { connected = true; });
  const warn = setInterval(() => {
    if (!connected) log("error", "wire connection NOT ESTABLISHED — wire-tools retrying; check ~/.wire/wire-connection.jsonl (common: 409 pubkey/encoding mismatch)", { waitedMs: 60_000 });
  }, 60_000);
  await started;
  clearInterval(warn);

  const initialPrompt = process.env.INITIAL_PROMPT;
  if (initialPrompt && !t.resumed) {
    if (gate.push({ text: initialPrompt, topic: "codex-wire.boot", source: "wire-codex", seq: undefined })) void pump();
  }

  // Independent time-budget tick: a wedged turn may emit no token updates, so
  // the wall-clock guard can't rely on onTokenUsage alone.
  if (guard.enabled) setInterval(() => enforceGuard(Date.now()), 15_000);

  log("info", "wire-codex up", { threadId, resumed: t.resumed, projectDir, wireUrl, userAgent, socketPath, turnGuard: { maxTurnTokens: MAX_TURN_TOKENS, maxTurnSeconds: MAX_TURN_SECONDS } });
}

main().catch((e) => {
  log("error", "fatal", { err: String(e?.stack ?? e) });
  try { appServer.close(); } catch {}
  process.exit(1);
});
