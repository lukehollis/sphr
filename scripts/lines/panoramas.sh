#!/usr/bin/env bash
# Line-drawing cube faces for Spacery panorama scenes, then upload to gs://spacery-static.
#
#   scripts/lines/panoramas.sh [WORK_DIR] [SCENE_ID ...]
#
# For each scene it downloads every node's six 1024 px faces (first 400 nodes in
# bootstrap order, plus the scene's initialNode if it sits past the cap), runs the
# informative-drawings contour model on each face at 1024x1024, writes the watercolor
# blend, and writes index.json. Then it uploads to
#   gs://spacery-static/sphr/lines/<sceneId>/{contour,watercolor}/<uuid>/<face>.jpg
#   gs://spacery-static/sphr/lines/<sceneId>/index.json
#
# Runs on a Mac (MPS, ~0.1 s per face on an M4 Max) or any CUDA box. Needs python3 with
# torch, numpy, opencv-python, Pillow, plus gcloud with write access to spacery-static.
# Set SKIP_UPLOAD=1 to only build locally. Re-running skips faces already done.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${1:-$PWD/linework}"
shift || true
SCENES=("$@")
if [ ${#SCENES[@]} -eq 0 ]; then
  # Inside the Tomb of Tutankhamun / The Sacred Way and Temple of Apollo, Delphi /
  # Walking Tour of the Sacred Way of Delphi (same 719 nodes as the space before it,
  # faces are cached once and stylized per scene) / The Acropolis, Athens
  SCENES=(963aef8db7f7 28b3a3cd2896 350761bfb956 ef49185cc195)
fi
WEIGHTS="${LINEWORK_WEIGHTS:-$WORK/weights}"
PY="${PYTHON:-python3}"

mkdir -p "$WORK"
bash "$HERE/fetch_weights.sh" "$WEIGHTS"

for s in "${SCENES[@]}"; do
  "$PY" "$HERE/linework.py" panos --scene "$s" --work "$WORK/cache" --out "$WORK/panos" \
    --weights "$WEIGHTS" --max-nodes "${MAX_NODES:-400}"
done

[ "${SKIP_UPLOAD:-0}" = 1 ] && exit 0

for s in "${SCENES[@]}"; do
  bash "$HERE/upload.sh" panos "$WORK/panos/$s" "$s"
done
