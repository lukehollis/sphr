#!/usr/bin/env bash
# Upload line-drawing outputs to the public spacery-static bucket.
#
#   scripts/lines/upload.sh panos  <dir with contour/ watercolor/ index.json> <sceneId>
#   scripts/lines/upload.sh splats <dir with *.ply preview-*.jpg cameras.json> <slug>
#
# Objects are immutable-style (Cache-Control max-age one year) except index.json and
# cameras.json, which stay short-lived (max-age 300) so they can be regenerated.
set -euo pipefail

BUCKET="${BUCKET:-gs://spacery-static}"
LONG="public, max-age=31536000"
SHORT="public, max-age=300"
kind="$1"; dir="$2"; id="$3"

case "$kind" in
  panos)
    dst="$BUCKET/sphr/lines/$id"
    for style in contour watercolor; do
      gcloud storage cp -r "$dir/$style" "$dst/" \
        --cache-control="$LONG" --content-type=image/jpeg
    done
    # index.json last, so it never lists faces that are not there yet
    gcloud storage cp "$dir/index.json" "$dst/index.json" \
      --cache-control="$SHORT" --content-type=application/json
    ;;
  splats)
    dst="$BUCKET/sphr/line-demos/$id"
    for f in "$dir"/*.ply; do
      gcloud storage cp "$f" "$dst/$(basename "$f")" \
        --cache-control="$LONG" --content-type=application/octet-stream
    done
    for f in "$dir"/preview-*.jpg; do
      [ -e "$f" ] || continue
      gcloud storage cp "$f" "$dst/$(basename "$f")" \
        --cache-control="$LONG" --content-type=image/jpeg
    done
    gcloud storage cp "$dir/cameras.json" "$dst/cameras.json" \
      --cache-control="$SHORT" --content-type=application/json
    ;;
  *)
    echo "usage: $0 panos|splats <dir> <sceneId|slug>" >&2; exit 2 ;;
esac
echo "uploaded $kind $id"
