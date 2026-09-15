#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" == Linux ]]; then
  sudo apt-get update
  sudo apt-get install -y bubblewrap
  # Ubuntu's hosted image may install the namespace profile without loading it.
  if [[ -f /etc/apparmor.d/bwrap ]]; then
    sudo apparmor_parser -r /etc/apparmor.d/bwrap
  elif [[ -f /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]]; then
    sudo tee /etc/apparmor.d/pr-review-bwrap >/dev/null <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>
profile pr-review-bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
PROFILE
    sudo apparmor_parser -r /etc/apparmor.d/pr-review-bwrap
  fi
  bwrap --unshare-user --unshare-pid --ro-bind / / -- /bin/true
fi

installer="$(mktemp)"
trap 'rm -f "$installer"' EXIT
curl -fsSL https://raw.githubusercontent.com/Dicklesworthstone/destructive_command_guard/v0.6.5/install.sh -o "$installer"
bash "$installer" --version v0.6.5 --no-configure --verify
npm install -g acpx@0.13.2 @openai/codex@0.154.0 @anthropic-ai/claude-code@2.1.272
echo "$HOME/.local/bin" >> "$GITHUB_PATH"
