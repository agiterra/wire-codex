import { CodexAgentServer } from "./src/agent-server.ts";
import { homedir } from "os";
import { join } from "path";

const AGDIR = join(homedir(), ".wire", "codex-agent-test2");
const socketPath = join(AGDIR, "control.sock");
const codexHome = join(AGDIR, "home");

async function main() {
  let reply: string | null = null;
  let done!: (v: string) => void;
  const completed = new Promise<string>((r) => (done = r));

  const srv = new CodexAgentServer({
    socketPath,
    codexHome,
    cwd: AGDIR,
    log: (l, m, f) => console.error(`[${l}] ${m}`, f ?? ""),
    onNotification: (method, params: any) => {
      if (method === "item/completed" && params?.item?.type === "agentMessage") reply = params.item.text;
      if (method === "turn/completed") done(reply ?? "(no reply)");
    },
  });

  const { userAgent } = await srv.start();
  console.error("userAgent:", userAgent);
  const { threadId } = await srv.ensureThread(null);
  console.error("threadId:", threadId);
  await srv.startTurn(threadId, "Reply with exactly: MODULE-PONG and nothing else.");
  const r = await Promise.race([
    completed,
    new Promise<string>((res) => setTimeout(() => res("TIMEOUT"), 60000)),
  ]);
  console.log("RESULT:", JSON.stringify(r));
  srv.close();
  process.exit(r === "TIMEOUT" ? 2 : 0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
