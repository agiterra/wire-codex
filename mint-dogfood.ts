import { readFileSync } from "fs";
import { importKeyPair, registerOrRefresh } from "@agiterra/wire-tools";

const WIRE_URL = process.env.WIRE_URL ?? "http://localhost:9800";
const fondantB64 = readFileSync(`${process.env.HOME}/.wire/keys/fondant.key`).toString("base64");

const sponsor = await importKeyPair(fondantB64);
const res = await registerOrRefresh(
  WIRE_URL, "fondant", sponsor.privateKey,
  "codex-dogfood", "Codex Dogfood",
  { force_rotate: true },   // fresh key each run; throwaway agent, no live holder
);
console.log(JSON.stringify({ agentId: res.agentId, mode: res.mode, pubkey: res.pubkey?.slice(0, 12) + "…", hasKey: !!res.privateKey }));
if (res.privateKey) console.log("PRIVKEY=" + res.privateKey);
else { console.error("NO PRIVATE KEY RETURNED (mode=" + res.mode + ")"); process.exit(1); }
