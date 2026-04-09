# wire-codex

Wire inbound adapter plugin for [Codex CLI](https://openai.com/index/openai-codex/).

Connects to The Wire message broker via SSE and delivers inbound messages as MCP channel notifications. Outbound messaging is handled by [wire-ipc-codex](https://github.com/agiterra/wire-ipc-codex).

## Usage

Install via Codex plugin manager or clone and reference locally.

## Config

Set these env vars before launching Codex:

| Variable | Default | Description |
|---|---|---|
| `WIRE_URL` | `http://localhost:9800` | Wire server URL |
| `WIRE_AGENT_ID` | auto-generated | Your agent's unique ID |
| `WIRE_AGENT_NAME` | same as ID | Display name |
| `WIRE_PRIVATE_KEY` | required | Base64 PKCS8 Ed25519 private key |

## Tools

- `set_plan` — Update your plan on the Wire dashboard
- `heartbeat_create` — Schedule a recurring prompt
- `heartbeat_delete` — Delete a scheduled heartbeat
- `heartbeat_list` — List scheduled heartbeats

## Part of the Agiterra ecosystem

- [wire-tools](https://github.com/agiterra/wire-tools) — shared primitives
- [wire-claude-code](https://github.com/agiterra/wire-claude-code) — Claude Code adapter
- [wire-ipc-codex](https://github.com/agiterra/wire-ipc-codex) — outbound IPC for Codex
