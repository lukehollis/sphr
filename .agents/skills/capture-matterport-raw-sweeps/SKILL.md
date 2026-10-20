---
name: capture-matterport-raw-sweeps
description: Raw Matterport Capture app export ZIP (metafile.json plus a folder of .swl/.dam/.mmp/.pb files and per-sweep skybox/cube-face JPEGs) with no E57; recognize it and turn the cube faces into panoramas for a tour.
learned: 2026-10-20 from processing job 6260c91a701e7509, reviewed (runner after review)
---

# Raw Matterport capture export

## Recognize
ZIP with `metafile.json` (platform, app_version) and one UUID folder containing `*.swl`, a `SweepProcessorData/` folder of `.dam`, `.mmp`, `*_sweep_cloud.pb`, `*_sweep_features.pb`, and JPEGs named `<sweepid>_{128,256,512}_00{0-5}.jpg` (cube faces) and sometimes `<id>_skybox{0-5}.jpg`. inspect-inputs shows only photos and unknowns. No E57, so sphr-matterport does not apply; the poses are in proprietary files that cannot be read.

## Steps
1. Faces: the `_512_000..005` set per sweep is a 512 px cube. Order seen: 0 = up, 1..4 = the four sides left to right (continuous seams), 5 = down. Up/down have a large unscanned grey disc (about 0.6 of the face half-width).
2. `/opt/venv/bin/python -I .agents/skills/capture-matterport-raw-sweeps/scripts/cube2equi.py <SweepProcessorData dir> <outdir> 1024` writes one 2:1 equirectangular JPEG per sweep and fills the grey caps.
3. Package with `build-panoramas.mjs` (sphr-panorama-package) from `<outdir>`.

## Check
View a panorama: upright, straight verticals, continuous seams at the 4 side joins. Check preview.jpg.

## Limits
Only 512 px faces exist, so output is low resolution. Stop order is by file name, not capture order, and positions are unknown, so no floor-plan layout. A tour is possible; a splat is not (no poses).
