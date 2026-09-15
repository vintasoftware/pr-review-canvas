#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" == Linux ]]; then
  sudo apt-get update
  sudo apt-get install -y bubblewrap
fi

installer="$(mktemp)"
trap 'rm -f "$installer"' EXIT
curl -fsSL https://raw.githubusercontent.com/Dicklesworthstone/destructive_command_guard/v0.6.5/install.sh -o "$installer"
bash "$installer" --version v0.6.5 --no-configure --verify
npm install -g acpx@0.13.2 @openai/codex@0.154.0 @anthropic-ai/claude-code@2.1.272
echo "$HOME/.local/bin" >> "$GITHUB_PATH"
