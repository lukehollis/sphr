#!/usr/bin/env bash
# Run from a clean checkout on the Debian x86_64 app VM.
set -euo pipefail
cd "$(dirname "$0")/../.."
exec 9>"/tmp/sphr-deploy-$(id -u).lock"
flock -n 9 || { echo 'Another SPHR deployment is already running.' >&2; exit 1; }
test -z "$(git status --porcelain --untracked-files=no)" || { echo 'Commit tracked changes before deploying.' >&2; exit 1; }
trap 'git restore --worktree next-env.d.ts tsconfig.json' EXIT
test "$(uname -m)" = x86_64 || { echo 'This runtime package requires an x86_64 VM.' >&2; exit 1; }

node_version="${SPHR_NODE_VERSION:-24.21.0}"
[[ "$node_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 1
node_home="$HOME/.local/share/sphr/node-v${node_version}-linux-x64"
if [[ ! -x "$node_home/bin/node" ]]; then
  download_dir=$(mktemp -d)
  archive="node-v${node_version}-linux-x64.tar.xz"
  curl --fail --location --retry 3 "https://nodejs.org/dist/v${node_version}/${archive}" -o "$download_dir/$archive"
  curl --fail --location "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" -o "$download_dir/SHASUMS256.txt"
  (cd "$download_dir"; grep " ${archive}$" SHASUMS256.txt | sha256sum --check --status)
  mkdir -p "$(dirname "$node_home")"
  tar -xJf "$download_dir/$archive" -C "$(dirname "$node_home")"
  rm -rf "$download_dir"
fi
export PATH="$node_home/bin:$PATH"
export NEXT_TELEMETRY_DISABLED=1 SPHR_HOSTED=1 SPHR_STANDALONE=1 SPHR_BUILD_CPUS=1
export NODE_OPTIONS=--max-old-space-size=1536
nice -n 10 npm ci --no-audit --no-fund
nice -n 10 npm run build

revision=$(git rev-parse HEAD)
release="${revision:0:12}-$(date -u +%Y%m%d%H%M%S)"
destination="/opt/sphr/releases/$release"
id -u sphr >/dev/null 2>&1 || sudo useradd --system --user-group --home-dir /var/lib/sphr --shell /usr/sbin/nologin sphr
sudo install -d -m 755 "$destination" /opt/sphr/runtime
sudo install -m 755 "$node_home/bin/node" "/opt/sphr/runtime/node-v$node_version"
sudo ln -sfn "node-v$node_version" /opt/sphr/runtime/node
sudo cp -a .next/standalone/. "$destination/"
sudo mkdir -p "$destination/.next/static" "$destination/public"
sudo cp -a .next/static/. "$destination/.next/static/"
(cd public; tar --exclude=./datasets --exclude=./demo -cf - .) | sudo tar -xf - -C "$destination/public"
printf '%s\n' "$revision" | sudo tee "$destination/REVISION" >/dev/null
sudo chown -R root:root "$destination"
sudo chmod -R go-w "$destination"
sudo install -d -m 755 -o sphr -g sphr /var/cache/sphr
sudo install -d -m 700 -o sphr -g sphr /var/lib/sphr
sudo rm -rf "$destination/.next/cache"
sudo ln -s /var/cache/sphr "$destination/.next/cache"
sudo install -m 644 scripts/deploy/sphr.service /etc/systemd/system/sphr.service

previous=""
if [[ -e /opt/sphr/current ]]; then previous=$(readlink -f /opt/sphr/current); fi
sudo ln -sfn "$destination" /opt/sphr/current.next
sudo mv -Tf /opt/sphr/current.next /opt/sphr/current
sudo systemctl daemon-reload
sudo systemctl enable sphr.service
sudo systemctl restart sphr.service
for attempt in {1..30}; do
  if curl --fail --silent --max-time 2 'http://127.0.0.1:3035/?demo=garden' -o /dev/null; then
    echo "SPHR deployed: $revision ($destination)"
    exit 0
  fi
  sleep 1
done
echo 'New service did not become healthy; restoring the previous release.' >&2
if [[ -n "$previous" ]]; then
  sudo ln -sfn "$previous" /opt/sphr/current.next
  sudo mv -Tf /opt/sphr/current.next /opt/sphr/current
  sudo systemctl restart sphr.service
fi
sudo journalctl -u sphr.service -n 30 --no-pager
exit 1
