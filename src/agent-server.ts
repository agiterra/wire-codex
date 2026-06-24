/**
 * CodexAgentServer — one `codex app-server` PROCESS per agent (Tim's call,
 * 2026-06-24: not a shared daemon). The plugin spawns it, connects as a
 * WebSocket-over-unix-socket client (the app-server's `--listen unix://`
 * transport carries JSON-RPC 2.0 as WS text frames), and drives a thread.
 *
 * Per-process env = the agent's identity: the spawned process reads its own
 * CODEX_HOME/config.toml (model, sandbox, and the `wire-ipc` MCP that signs
 * outbound with THIS agent's AGENT_PRIVATE_KEY). So inbound (Wire → turn/start,
 * here) and outbound (agent → wire-ipc MCP) both carry the agent's identity.
 *
 * THE load-bearing gotcha: the WS server (tokio-tungstenite, default config)
 * does NOT support permessage-deflate; every off-the-shelf WS lib offers it by
 * default and the server silently aborts the upgrade. We pass
 * `perMessageDeflate: false`. Recipe verified live (PER-AGENT-PONG, 0.140).
 * See Fondant vault reference-codex-appserver-daemon-protocol.md.
 */

import { spawn, type ChildProcess } from "child_process";
import { rmSync } from "fs";
import { WebSocket } from "ws";

type Json = Record<string, unknown>;
type Pending = { resolve: (v: Json) => void; reject: (e: Error) => void };

export type AgentServerOptions = {
  /** Real-path socket for `--listen unix://` (NOT under /tmp — macOS symlink trips codex). */
  socketPath: string;
  /** Provisioned per-agent CODEX_HOME (config.toml + auth.json), e.g. from codex-launch.sh. */
  codexHome: string;
  /** Working directory for the agent's thread. */
  cwd: string;
  /** Extra process env (merged over the parent env). */
  env?: Record<string, string>;
  onNotification?: (method: string, params: Json) => void;
  log?: (level: "info" | "warn" | "error", msg: string, fields?: Json) => void;
};

export class CodexAgentServer {
  private child: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private opts: AgentServerOptions;
  private closed = false;

  constructor(opts: AgentServerOptions) {
    this.opts = opts;
  }

  private log(level: "info" | "warn" | "error", msg: string, fields?: Json) {
    this.opts.log?.(level, msg, fields);
  }

  /** Spawn the per-agent app-server, connect over WS, and complete the MCP-style handshake. */
  async start(): Promise<{ userAgent: string }> {
    const { socketPath, codexHome, cwd, env } = this.opts;
    rmSync(socketPath, { force: true });
    this.child = spawn(
      "codex",
      ["app-server", "--listen", `unix://${socketPath}`],
      {
        cwd,
        env: { ...process.env, CODEX_HOME: codexHome, ...env },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (d: string) =>
      this.log("warn", "app-server stderr", { line: String(d).slice(0, 300) }),
    );
    this.child.on("exit", (code) => {
      this.log(this.closed ? "info" : "error", "app-server exited", { code });
      for (const [, p] of this.pending) p.reject(new Error(`app-server exited (code ${code})`));
      this.pending.clear();
    });

    await this.waitForSocket(socketPath);
    await this.connectWs(socketPath);
    const init = await this.request("initialize", {
      clientInfo: { name: "wire-codex", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
    const userAgent = String(init.userAgent ?? "");
    this.log("info", "agent app-server up", { userAgent, socketPath });
    return { userAgent };
  }

  private async waitForSocket(path: string): Promise<void> {
    const { existsSync } = await import("fs");
    for (let i = 0; i < 40; i++) {
      if (existsSync(path)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`app-server socket never appeared: ${path}`);
  }

  private connectWs(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // ws+unix URL: ws+unix://<abs-socket-path>:/<http-path>
      const ws = new WebSocket(`ws+unix://${socketPath}:/`, { perMessageDeflate: false });
      this.ws = ws;
      ws.on("open", () => resolve());
      ws.on("error", (e) => reject(e instanceof Error ? e : new Error(String(e))));
      ws.on("message", (data: Buffer) => this.onMessage(data.toString("utf8")));
      ws.on("close", () => {
        if (!this.closed) this.log("warn", "ws closed unexpectedly");
      });
    });
  }

  private onMessage(line: string): void {
    let m: Json;
    try { m = JSON.parse(line); } catch { return; }
    const id = m.id as number | string | undefined;
    const method = m.method as string | undefined;

    if (id != null && method == null) {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (m.error) p.reject(new Error(`app-server error: ${JSON.stringify(m.error)}`));
      else p.resolve((m.result ?? {}) as Json);
      return;
    }
    if (id != null && method != null) {
      // Server→client REQUEST (approval/elicitation/auth-refresh) — MUST answer
      // or the turn stalls. Auto-reject; engineers run approval_policy=never.
      this.send({ jsonrpc: "2.0", id, error: { code: -32000, message: `wire-codex does not handle ${method}` } });
      this.log("info", "auto-rejected server request", { method });
      return;
    }
    if (method != null) {
      this.opts.onNotification?.(method, (m.params ?? {}) as Json);
    }
  }

  private send(msg: Json): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("ws not open");
    this.ws.send(JSON.stringify(msg));
  }

  request(method: string, params?: Json): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    });
  }

  notify(method: string, params?: Json): void {
    this.send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  // --- Thread/turn helpers ---

  /** Resume a persisted thread, else start fresh. Tolerates the -32600 no-rollout race. */
  async ensureThread(persistedThreadId: string | null): Promise<{ threadId: string; resumed: boolean }> {
    if (persistedThreadId) {
      try {
        const r = await this.request("thread/resume", { threadId: persistedThreadId });
        const threadId = this.extractThreadId(r) ?? persistedThreadId;
        this.log("info", "thread resumed", { threadId });
        return { threadId, resumed: true };
      } catch (e) {
        this.log("warn", "thread/resume failed — starting fresh", { err: String(e) });
      }
    }
    const r = await this.request("thread/start", { cwd: this.opts.cwd });
    const threadId = this.extractThreadId(r);
    if (!threadId) throw new Error(`thread/start returned no threadId: ${JSON.stringify(r)}`);
    this.log("info", "thread started", { threadId });
    return { threadId, resumed: false };
  }

  private extractThreadId(r: Json): string | null {
    return (
      ((r.thread as Json | undefined)?.id as string | undefined) ??
      (r.threadId as string | undefined) ??
      null
    );
  }

  /** Start a turn; returns its turnId (Turn.id) so a guard can later interrupt it. */
  async startTurn(threadId: string, text: string): Promise<string> {
    const r = await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text }],
    });
    return ((r.turn as Json | undefined)?.id as string | undefined) ?? "";
  }

  /** Abort a runaway turn. turn/interrupt requires BOTH threadId and turnId. */
  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  close(): void {
    this.closed = true;
    try { this.ws?.close(); } catch {}
    try { this.child?.kill(); } catch {}
    try { rmSync(this.opts.socketPath, { force: true }); } catch {}
  }
}
