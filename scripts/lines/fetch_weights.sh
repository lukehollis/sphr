#!/usr/bin/env bash
# Fetch the pretrained informative-drawings generators (Chan, Isola, Durand, CVPR 2022)
# into <dest>/<style>_style/netG_A_latest.pth for style in contour, anime, opensketch.
# Same source as splatline's scripts/fetch_weights.sh: the authors' Google Drive zip
# linked from github.com/carolineec/informative-drawings (code MIT; the weights carry
# no separate license file).
#
#   scripts/lines/fetch_weights.sh [dest]   (default ./weights)
set -euo pipefail

DEST="${1:-./weights}"
GAN_ZIP_ID="1MIdHzecxz-z0uY3ARL_R40DlKcuQxiDk"
# sha256 of the files fetched on 2026-10-03, so a changed upload is noticed
CONTOUR_SHA="e8b6ec6db973dce9e9a455115514be72f569081651c561a1a8d96d78bb3ece5f"

mkdir -p "$DEST"
if [ ! -f "$DEST/contour_style/netG_A_latest.pth" ]; then
  tmp="$(mktemp -d)"
  if command -v uvx >/dev/null; then
    uvx gdown "$GAN_ZIP_ID" -O "$tmp/model.zip"
  else
    python3 -m pip install --quiet --user gdown && python3 -m gdown "$GAN_ZIP_ID" -O "$tmp/model.zip"
  fi
  unzip -o -q "$tmp/model.zip" -d "$tmp"
  # the zip nests everything under model/<style>_style
  for d in "$tmp"/model/*_style; do rm -rf "$DEST/$(basename "$d")"; mv "$d" "$DEST/"; done
  find "$DEST" -name .DS_Store -delete
  rm -rf "$tmp"
fi

got="$( (sha256sum "$DEST/contour_style/netG_A_latest.pth" 2>/dev/null || shasum -a 256 "$DEST/contour_style/netG_A_latest.pth") | cut -d' ' -f1)"
if [ "$got" != "$CONTOUR_SHA" ]; then
  echo "warning: contour weights sha256 $got differs from the 2026-10-03 copy" >&2
fi
echo "weights ready in $DEST: $(ls -d "$DEST"/*_style | xargs -n1 basename | tr '\n' ' ')"
