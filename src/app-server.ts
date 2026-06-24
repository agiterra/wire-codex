/**
 * CodexAppServer — thin JSON-RPC 2.0 client over a `codex app-server`
 * stdio child. One child per bridge process, one thread per agent (v0).
 *
 * Protocol: newline-delimited JSON, no headers.
 *   client→server requests get numeric ids; notifications have none.
 *   server→client REQUESTS (id + method) must be answered or codex hangs —
 *   unhandled ones get a method-not-found error and a loud log, by design:
 *   silence is how half-boots happen.
 *
 * Docs: https://developers.openai.com/codex/app-server
 */

import { spawn, type ChildProcessByStdio } from "child_process";
import type { Readable, Writable } from "stream";

type Json = Record<string, unknown>;
type Pending = { resolve: (v: Json) => void; reject: (e: Error) => void };

export type AppServerOptions = {
  /** Working directory for the codex thread (the agent's project dir). */
  cwd: string;
  /** Extra `-c key=value` config overrides for the child (approval policy, sandbox, …). */
  configOverrides?: string[];
  onNotification?: (method: string, params: Json) => void;
  log?: (level: "info" | "warn" | "error", msg: string, fields?: Json) => void;
};

export class CodexAppServer {
  private child: ChildProcessByStdio<Writable, Readable, null> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private opts: AppServerOptions;

  constructor(opts: AppServerOptions) {
    this.opts = opts;
  }

  private log(level: "info" | "warn" | "error", msg: string, fields?: Json) {
    this.opts.log?.(level, msg, fields);
  }

  async start(): Promise<void> {
    const args = ["app-server"];
    for (const ov of this.opts.configOverrides ?? []) args.push("-c", ov);
    const child = spawn("codex", args, { stdio: ["pipe", "pipe", "ignore"] });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.on("exit", (code: number | null) => {
      this.log("error", "app-server exited", { code });
      for (const [, p] of this.pending) p.reject(new Error(`app-server exited (code ${code})`));
      this.pending.clear();
    });

    await this.request("initialize", {
      clientInfo: { name: "codex-wire-bridge", version: "0.1.0" },
    });
    this.notify("initialized");
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: Json;
      try {
        msg = JSON.parse(line) as Json;
      } catch {
        this.log("warn", "unparseable line from app-server", { line: line.slice(0, 200) });
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Json): void {
    const id = msg.id as number | undefined;
    const method = msg.method as string | undefined;

    if (id != null && method == null) {
      // Response to one of our requests.
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (msg.error) p.reject(new Error(`app-server error: ${JSON.stringify(msg.error)}`));
      else p.resolve((msg.result ?? {}) as Json);
      return;
    }

    if (id != null && method != null) {
      // Server→client REQUEST. Must answer. v0 handles none — approval
      // policy is configured to never prompt — so refuse loudly rather
      // than hang silently.
      this.log("error", "unhandled server request — refusing", { method });
      this.send({ id, error: { code: -32601, message: `codex-wire-bridge does not handle ${method}` } });
      return;
    }

    if (method != null) {
      this.opts.onNotification?.(method, (msg.params ?? {}) as Json);
    }
  }

  private send(msg: Json): void {
    if (!this.child) throw new Error("app-server not started");
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  request(method: string, params?: Json): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ method, id, ...(params ? { params } : {}) });
    });
  }

  notify(method: string, params?: Json): void {
    this.send({ method, ...(params ? { params } : {}) });
  }

  // --- Thread/turn helpers ---

  /** Resume a persisted thread or start a fresh one. Returns the threadId. */
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
      (r.threadId as string | undefined) ??
      ((r.thread as Json | undefined)?.id as string | undefined) ??
      null
    );
  }

  async startTurn(threadId: string, text: string): Promise<void> {
    await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text }],
    });
  }
}
