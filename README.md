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
| `AGENT_ID` | auto-generated | Agent identifier |
| `AGENT_NAME` | same as agent ID | Display name |
| `AGENT_PRIVATE_KEY` | required | Base64 Ed25519 private key |

## What it does

Connects to The Wire message broker via SSE and delivers inbound messages as MCP channel notifications. Outbound messaging is handled by [wire-ipc-codex](https://github.com/agiterra/wire-ipc-codex).

## Source

- Tools: [@agiterra/wire-tools](https://github.com/agiterra/wire-tools)
- Claude Code adapter: [@agiterra/wire-claude-code](https://github.com/agiterra/wire-claude-code)
