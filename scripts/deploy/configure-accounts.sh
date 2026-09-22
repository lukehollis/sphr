#!/usr/bin/env bash
# Stores the sign-in and billing secrets for customer accounts in the service environment
# and prepares Stripe. Run on the app VM from a checkout whose dependencies are installed
# (the deploy checkout). It asks for each secret; nothing is passed on the command line.
#   bash scripts/deploy/configure-accounts.sh [--google-json client_secret.json]
# --google-json reads the client ID and secret from the file Google Cloud offers to download
# when a web client is created, then deletes that copy.
set -euo pipefail
google_json=""
[[ "${1:-}" == "--google-json" ]] && google_json="${2:?Pass the downloaded client secret file.}"
cd "$(dirname "$0")/../.."
node_bin=$(ls -d "$HOME"/.local/share/sphr/node-v*-linux-x64/bin 2>/dev/null | sort -V | tail -1 || true)
[[ -n "$node_bin" ]] && export PATH="$node_bin:$PATH"
env_file="${SPHR_ENV_FILE:-/etc/sphr/environment}"
build_env="${SPHR_BUILD_ENV:-/etc/sphr/build.env}"
current() { sudo grep -E "^$1=" "$env_file" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
origin=$(current SPHR_PUBLIC_URL); [[ -z "$origin" && -f "$build_env" ]] && origin=$(grep -E '^SPHR_PUBLIC_URL=' "$build_env" | tail -1 | cut -d= -f2-)
[[ -n "$origin" ]] || { echo 'Set SPHR_PUBLIC_URL in the environment or build settings first.' >&2; exit 1; }
echo "Configuring customer accounts for $origin (Enter keeps a current value)."
if [[ -n "$google_json" ]]; then
  google_id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["web"]["client_id"])' "$google_json")
  google_secret=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["web"]["client_secret"])' "$google_json")
  shred -u "$google_json" 2>/dev/null || rm -f "$google_json"
  echo "Google client $google_id read from the downloaded file."
else
  read -r -p "Google OAuth client ID [$(current SPHR_GOOGLE_CLIENT_ID)]: " google_id
  read -r -s -p "Google OAuth client secret: " google_secret; echo
fi
read -r -s -p "Stripe secret key (sk_test_… or sk_live_…): " stripe_key; echo
read -r -p "Monthly price per space, in cents [200]: " amount
google_id=${google_id:-$(current SPHR_GOOGLE_CLIENT_ID)}
google_secret=${google_secret:-$(current SPHR_GOOGLE_CLIENT_SECRET)}
stripe_key=${stripe_key:-$(current SPHR_STRIPE_SECRET_KEY)}
previous_key=$(current SPHR_STRIPE_SECRET_KEY)
webhook_secret=$(current SPHR_STRIPE_WEBHOOK_SECRET)
# A different Stripe account or mode needs its own webhook endpoint and secret.
[[ "$stripe_key" != "$previous_key" ]] && webhook_secret=""
settings=$(printf 'SPHR_GOOGLE_CLIENT_ID=%s\nSPHR_GOOGLE_CLIENT_SECRET=%s\nSPHR_STRIPE_SECRET_KEY=%s\n' "$google_id" "$google_secret" "$stripe_key")
if [[ -n "$stripe_key" ]]; then
  stripe_settings=$(SPHR_STRIPE_SECRET_KEY="$stripe_key" SPHR_STRIPE_WEBHOOK_SECRET="$webhook_secret" node scripts/deploy/stripe-setup.mjs --origin "$origin" --amount "${amount:-200}")
  settings=$(printf '%s\n%s\n' "$settings" "$stripe_settings")
fi
# Replace or append each setting, keeping the file's owner and mode; values travel on stdin only.
printf '%s\n' "$settings" | sudo python3 -c '
import os, sys
path = sys.argv[1]
updates = dict(line.split("=", 1) for line in sys.stdin.read().splitlines() if "=" in line and line.split("=", 1)[1])
lines = open(path).read().splitlines() if os.path.exists(path) else []
kept = [line for line in lines if line.split("=", 1)[0] not in updates]
stat = os.stat(path) if os.path.exists(path) else None
temp = path + ".tmp"
with open(temp, "w") as stream:
    stream.write("\n".join(kept + [f"{key}={value}" for key, value in updates.items()]) + "\n")
os.chmod(temp, stat.st_mode & 0o777 if stat else 0o600)
if stat: os.chown(temp, stat.st_uid, stat.st_gid)
os.replace(temp, path)
print("Updated " + ", ".join(sorted(updates)) + " in " + path)
' "$env_file"
sudo systemctl restart sphr.service
sleep 3
systemctl is-active sphr.service
