#!/usr/bin/env bash
set -euo pipefail

apt-get update
apt-get install -y bubblewrap curl xz-utils git ca-certificates

# WSL executes without a login shell, so Node and dcg must be on its ordinary PATH.
node_version=24.14.1
download="$(mktemp -d)"
trap 'rm -rf "$download"' EXIT
cd "$download"
curl -fsSLO "https://nodejs.org/dist/v${node_version}/node-v${node_version}-linux-x64.tar.xz"
curl -fsSLO "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt"
sha256sum --check --ignore-missing SHASUMS256.txt
tar -xJf "node-v${node_version}-linux-x64.tar.xz" -C /usr/local --strip-components=1
curl -fsSL https://raw.githubusercontent.com/Dicklesworthstone/destructive_command_guard/v0.6.5/install.sh -o install-dcg.sh
bash install-dcg.sh --version v0.6.5 --dest /usr/local/bin --no-configure --verify
npm install -g acpx@0.13.2 @openai/codex@0.154.0 @anthropic-ai/claude-code@2.1.272
node --version
dcg --version
