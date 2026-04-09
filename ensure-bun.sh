#!/usr/bin/env bash
# Ensure Bun is installed. Idempotent, platform-agnostic (macOS/Linux/WSL).
# Called from postInstall — exits 0 if Bun is already available.

if command -v bun >/dev/null 2>&1; then
  exit 0
fi

echo "[crew] Bun not found — installing..."

if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]]; then
  # Windows (Git Bash / MSYS2)
  powershell -c "irm bun.sh/install.ps1 | iex" 2>&1
else
  # macOS / Linux / WSL
  curl -fsSL https://bun.sh/install | bash 2>&1
fi

# Source the new PATH so bun is available in this session
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

if command -v bun >/dev/null 2>&1; then
  echo "[crew] Bun installed: $(bun --version)"
else
  echo "[crew] ERROR: Bun installation failed. Install manually: https://bun.sh" >&2
  exit 1
fi
