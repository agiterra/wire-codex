#!/usr/bin/env bun
import { startServer } from "@agiterra/wire-tools";

startServer().catch((e) => {
  console.error("[wire] fatal:", e);
  process.exit(1);
});
