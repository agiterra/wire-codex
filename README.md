# wire-codex

Codex CLI plugin for The Wire — inbound SSE connection and MCP channel notifications.

## Usage

Install via Codex CLI:

```
codex plugin install agiterra/wire-codex
```

## Configuration

| Env var | Default | Description |
|---|---|---|
| `WIRE_URL` | `http://localhost:9800` | Wire broker URL |
| `WIRE_AGENT_ID` | auto-generated | Agent identifier |
| `WIRE_AGENT_NAME` | same as agent ID | Display name |
| `WIRE_PRIVATE_KEY` | required | Base64 Ed25519 private key |

`CREW_AGENT_ID`, `CREW_AGENT_NAME`, and `CREW_PRIVATE_KEY` override the above when set by the crew launcher.

## What it does

Connects to The Wire message broker via SSE and delivers inbound messages as MCP channel notifications. Outbound messaging is handled by [wire-ipc-codex](https://github.com/agiterra/wire-ipc-codex).

## Source

- Tools: [@agiterra/wire-tools](https://github.com/agiterra/wire-tools)
- Claude Code adapter: [@agiterra/wire-claude-code](https://github.com/agiterra/wire-claude-code)
