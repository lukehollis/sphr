---
name: sphr-video
description: Reconstruct an ordinary (non-360) walkthrough video or a set of overlapping photos into a Gaussian splat with COLMAP and an available splat trainer, then package it; hold for an operator when no trainer is available.
---

# Video and photo-set reconstruction

Ordinary video or photos become a 3D space only through reconstruction: camera poses with COLMAP, then
Gaussian splat training. Training needs a GPU trainer; check what this machine has:

```sh
command -v colmap; command -v brush_app brush opensplat ns-train 2>/dev/null
```

If no trainer is available, do not try to train on the CPU. Extract frames, run COLMAP if it is quick,
and report `needs_operator` with what you found (frame count, whether COLMAP registered most frames).

## 1. Frames

```sh
node scripts/packages/video-frames.mjs --input "<video>" --output "$SPHR_JOB_DIR/work/frames" [--fps 2] [--max-frames 300] [--width 1600]
```

For photo sets, copy the photos into `work/frames` instead. Reconstruction needs 60–300 sharp, overlapping
views that move around the space. Fewer than ~40 usable frames, a tripod-still camera, or heavy motion blur:
report `failed` and ask for a slower walkthrough that circles the space.

## 2. Camera poses

```sh
colmap automatic_reconstructor --workspace_path "$SPHR_JOB_DIR/work/colmap" --image_path "$SPHR_JOB_DIR/work/frames" \
  --dense 0 --single_camera 1 --quality medium
```

Check `work/colmap/sparse/0` exists and most frames registered (`colmap model_analyzer --path work/colmap/sparse/0`).

## 3. Train and package

With Brush: `brush_app "$SPHR_JOB_DIR/work/colmap" --total-steps 15000 --export-path "$SPHR_JOB_DIR/work/splat"`.
With OpenSplat: `opensplat "$SPHR_JOB_DIR/work/colmap" -n 15000 -o "$SPHR_JOB_DIR/work/splat/scene.ply"`.
Then package the PLY; COLMAP's axes usually need `--rotation 180,0,0`:

```sh
node scripts/packages/build-splat.mjs --input "$SPHR_JOB_DIR/work/splat/scene.ply" --title "<title>" --rotation 180,0,0
```

Look at `preview.jpg` and adjust the rotation until the floor is at the bottom.
