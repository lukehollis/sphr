#!/usr/bin/env bash
# Installs the processing runner as a macOS login agent that runs the agent in Docker.
# Needs ~/.config/sphr-worker/environment (see docs/accounts.md), Docker Desktop, gcloud
# signed in with access to the upload and asset buckets, and Node on the login PATH.
#   bash scripts/worker/install-mac-worker.sh
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
env_file="$HOME/.config/sphr-worker/environment"
label=dev.sphr.worker
log="$HOME/Library/Logs/sphr-worker.log"
[[ -f "$env_file" ]] || { echo "Create $env_file first (see docs/accounts.md)." >&2; exit 1; }
if ! grep -q '^CLAUDE_CODE_OAUTH_TOKEN=' "$env_file" && ! grep -q '^ANTHROPIC_API_KEY=' "$env_file"; then
  echo "Paste the token printed by 'claude setup-token' (input hidden), then press Enter:"
  read -r -s token; echo
  [[ -n "$token" ]] || { echo 'No token entered.' >&2; exit 1; }
  printf "CLAUDE_CODE_OAUTH_TOKEN='%s'\n" "$token" >> "$env_file"
  chmod 600 "$env_file"
fi
docker image inspect sphr-agent >/dev/null 2>&1 || docker build -f "$repo/scripts/worker/agent.Dockerfile" -t sphr-agent "$repo"
plist="$HOME/Library/LaunchAgents/$label.plist"
mkdir -p "$(dirname "$plist")"
cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>set -a; source "$env_file"; set +a; cd "$repo" &amp;&amp; exec node scripts/worker/agent-runner.mjs run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict></plist>
PLIST
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
sleep 3
tail -3 "$log" 2>/dev/null || true
echo "The runner starts at login and waits for jobs. Log: $log"
echo "Stop it with: launchctl bootout gui/$(id -u)/$label"
