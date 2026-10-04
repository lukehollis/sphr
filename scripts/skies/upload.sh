#!/usr/bin/env bash
# Upload the sky library or a space's sky outlines to the public spacery-static bucket.
#
#   scripts/skies/upload.sh library <build.py --out dir>
#   scripts/skies/upload.sh masks <masks.py --out dir>/<sceneId> <sceneId>
#
# Images never change once uploaded (Cache-Control one year); index.json stays short-lived
# (five minutes) and goes last, so it never lists files that are not there yet.
set -euo pipefail

BUCKET="${BUCKET:-gs://spacery-static}"
LONG="public, max-age=31536000"
SHORT="public, max-age=300"
kind="$1"; dir="$2"

case "$kind" in
  library)
    for folder in "$dir"/*/; do
      gcloud storage cp -r "${folder%/}" "$BUCKET/skies/" --cache-control="$LONG" --content-type=image/jpeg
    done
    gcloud storage cp "$dir/index.json" "$BUCKET/skies/index.json" --cache-control="$SHORT" --content-type=application/json
    ;;
  masks)
    id="$3"
    dst="$BUCKET/sphr/lines/$id"
    if [ -d "$dir/sky" ]; then
      gcloud storage cp -r "$dir/sky" "$dst/" --cache-control="$LONG" --content-type=image/jpeg
    fi
    gcloud storage cp "$dir/index.json" "$dst/index.json" --cache-control="$SHORT" --content-type=application/json
    ;;
  *)
    echo "usage: $0 library <dir> | masks <dir> <sceneId>" >&2; exit 2 ;;
esac
echo "uploaded $kind"
