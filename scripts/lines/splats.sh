#!/usr/bin/env bash
# Train three Gaussian splats of one posed capture with identical settings and poses:
#   color       the original training images
#   contour     informative-drawings contour line drawings of those images
#   watercolor  the line drawings multiplied over a blurred, saturated copy of the photo
# then export PLYs, cameras.json and preview JPEGs. Run on the GPU box (siracusa):
#
#   scripts/lines/splats.sh <slug> <dataset dir with images/ and sparse/0/> [work root]
#   e.g. splats.sh hcrg /home/lrh/spacery-worker/local/gs-compare/hcrg/data
#
# Uses the worker's Docker images without touching the worker itself:
#   sphr-agent-gpu-next  torch + gsplat in /opt/nerfstudio (line drawings, preview renders)
#   sphr-agent-gpu       Brush (brush_app), same flags as the worker's sphr-video skill
#                        but capped at 1,000,000 splats
# Jobs run one at a time. Outputs: <work>/<slug>/out/{color,contour,watercolor}.ply,
# cameras.json, preview-*.jpg, ready for scripts/lines/upload.sh splats.
#
# NOT YET RUN (written 2026-10-03 while siracusa was unreachable). Before the first run,
# check `docker run --rm sphr-agent-gpu brush_app --help` for --seed (drop it if Brush
# v0.3.0 lacks it), and that sphr-agent-gpu-next's /opt/nerfstudio python has cv2.
set -euo pipefail

SLUG="$1"; SRC="$2"; W="${3:-/home/lrh/linework}"
HERE="$(cd "$(dirname "$0")" && pwd)"
STEPS="${STEPS:-15000}"
MAX_SPLATS="${MAX_SPLATS:-1000000}"
# Line drawings are made at the training resolution Brush will use (it downscales to
# at most 1920 px); LINE_MAX_SIDE caps the size the GAN sees, larger frames are drawn
# at that size and scaled back up so names and pixel sizes match the color set.
LINE_MAX_SIDE="${LINE_MAX_SIDE:-1920}"
WORKER_SCRIPTS="${WORKER_SCRIPTS:-/home/lrh/spacery-worker/.agents/skills/sphr-train-3dgs/scripts}"
DOCKER_GPU=(docker run --rm --gpus all -e NVIDIA_DRIVER_CAPABILITIES=all --network none
            --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$W:/w")

D="$W/$SLUG"
mkdir -p "$W/scripts" "$D/out"
cp "$HERE"/*.py "$W/scripts/"
bash "$HERE/fetch_weights.sh" "$W/weights"

# 1. three training folders that share the same COLMAP model
for style in color contour watercolor; do
  mkdir -p "$D/$style/sparse"
  rm -rf "$D/$style/sparse/0"; cp -r "$SRC/sparse/0" "$D/$style/sparse/0"
done
if [ ! -d "$D/color/images" ]; then cp -r "$SRC/images" "$D/color/images"; fi

# 2. line drawings + watercolor with exactly the same file names and pixel sizes
"${DOCKER_GPU[@]}" sphr-agent-gpu-next /opt/nerfstudio/bin/python /w/scripts/linework.py stylize \
  --input "/w/$SLUG/color/images" --contour "/w/$SLUG/contour/images" \
  --watercolor "/w/$SLUG/watercolor/images" --weights /w/weights --quality 95 --batch 1 \
  --max-side "$LINE_MAX_SIDE"

# 3. train, one after another, same flags and seed for all three
for style in color contour watercolor; do
  [ -f "$D/out/$style.ply" ] && [ -f "$D/out/$style.done" ] && continue
  start=$(date +%s)
  "${DOCKER_GPU[@]}" sphr-agent-gpu brush_app "/w/$SLUG/$style" \
    --total-steps "$STEPS" --max-splats "$MAX_SPLATS" --seed 42 \
    --export-path "/w/$SLUG/out" --export-name "$style.ply" --export-every 5000 \
    > "$D/out/brush-$style.log" 2>&1
  echo "$(( $(date +%s) - start ))" > "$D/out/$style.done"
  echo "$SLUG $style trained in $(cat "$D/out/$style.done")s"
done

# 4. cameras.json from the shared COLMAP model
"${DOCKER_GPU[@]}" sphr-agent-gpu-next /opt/nerfstudio/bin/python /w/scripts/cameras.py \
  --model "/w/$SLUG/color/sparse/0" --out "/w/$SLUG/out/cameras.json" --count 3 --ply "/w/$SLUG/out/color.ply"

# 5. previews: each splat rendered from the first capture camera, beside its training image
mkdir -p "$W/scripts/worker"
cp "$WORKER_SCRIPTS/render_views.py" "$W/scripts/worker/"
for style in color contour watercolor; do
  rm -rf "$D/renders/$style"
  "${DOCKER_GPU[@]}" sphr-agent-gpu-next /opt/nerfstudio/bin/python /w/scripts/worker/render_views.py \
    --ply "/w/$SLUG/out/$style.ply" --model "/w/$SLUG/color/sparse/0" --out "/w/$SLUG/renders/$style" \
    --every 1000000 --max-size 1280
done
"${DOCKER_GPU[@]}" sphr-agent-gpu-next /opt/nerfstudio/bin/python /w/scripts/previews.py \
  --root "/w/$SLUG" --out "/w/$SLUG/out"
ls -la "$D/out"
