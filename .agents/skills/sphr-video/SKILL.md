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

GPU workers have Brush (section 3). If no trainer is available, do not try to train on the CPU. Extract
frames, run COLMAP if it is quick, and report `needs_operator` with what you found (frame count, whether
COLMAP registered most frames).

## 1. Frames

```sh
node scripts/packages/video-frames.mjs --input "<video>" --output "$SPHR_JOB_DIR/work/frames" [--fps 2] [--max-frames 300] [--width 1600]
```

For photo sets, copy the photos into `work/frames` instead. Reconstruction needs 60–300 sharp, overlapping
views that move around the space. Fewer than ~40 usable frames, a tripod-still camera, or heavy motion blur:
report `failed` and ask for a slower walkthrough that circles the space.

## 2. Camera poses

```sh
QT_QPA_PLATFORM=offscreen colmap automatic_reconstructor --workspace_path "$SPHR_JOB_DIR/work/colmap" \
  --image_path "$SPHR_JOB_DIR/work/frames" --dense 0 --single_camera 1 --quality medium --use_gpu 0 \
  --data_type video     # frames from one video; use --data_type individual for a set of photos
```

Matching runs on the CPU, so pick the matcher by where the frames came from. `video` matches each frame
with its neighbours (about 4 s a frame for 108 frames at 1600 px, so 8 minutes); `individual` matches every
pair, which suits orbit photo sets up to about 150 but took 6.5 minutes per block of a 108-frame video. Run
COLMAP in the background with its output in `work/colmap.log` and check on it, rather than letting a
command time out and starting over.

COLMAP here is built without CUDA: its default GPU SIFT crashes with a stack trace, so keep `--use_gpu 0`
(for the step-by-step commands, `--SiftExtraction.use_gpu 0` and `--SiftMatching.use_gpu 0`). Phone
captures are often HEIC; convert frames to JPEG first with Pillow and `pillow_heif`.

Check `work/colmap/sparse/0` exists and most frames registered (`colmap model_analyzer --path work/colmap/sparse/0`).
When the walk loses track (fast turns, blank walls), COLMAP starts over and writes several models
(`sparse/0`, `sparse/1`, …) in the order it built them, not by size. Run `model_analyzer` on each and train
on the one with the most registered images; tell the customer if a large part of the video was left out.

## 3. Train and package

**Brush** is installed on GPU workers (`SPHR_GPU=nvidia` is set and `brush_app` exists). It trains on the GPU
and reads a folder that holds `images/` and `sparse/0/` side by side, so copy COLMAP's model next to the
frames it used:

```sh
mkdir -p "$SPHR_JOB_DIR/work/data/sparse"
cp -r "$SPHR_JOB_DIR/work/colmap/sparse/0" "$SPHR_JOB_DIR/work/data/sparse/0"   # work/data/images = the frames COLMAP used
brush_app "$SPHR_JOB_DIR/work/data" --total-steps 15000 --export-path "$SPHR_JOB_DIR/work/splat" \
  --export-name scene.ply --export-every 15000 > "$SPHR_JOB_DIR/work/brush.log" 2>&1
```

Measured on the RTX 3090 Ti: 105 photos at 1600 px register in COLMAP (CPU) in about 4 minutes and
train 15,000 steps in about 8.5 minutes, giving a ~100 MB PLY. Write a progress line before training
("Training the 3D scene on the GPU, about 10 minutes"). Brush loads images at up to 1920 px
(`--max-resolution`). It runs headless; never pass `--with-viewer`.
With OpenSplat: `opensplat "$SPHR_JOB_DIR/work/colmap" -n 15000 -o "$SPHR_JOB_DIR/work/splat/scene.ply"`.
Then package the PLY with the COLMAP model it was trained from:

```sh
node scripts/packages/build-splat.mjs --input "$SPHR_JOB_DIR/work/splat/scene.ply" --title "<title>" \
  --cameras "$SPHR_JOB_DIR/work/data/sparse/0"
```

`--cameras` levels the capture from how the camera was held and opens the space from a real capture
position: photos circling a subject orbit the point every camera looked at, and a walkthrough starts in
first person a few steps into the walk. The output's `start.kind` says which (`orbit` or `walkthrough`);
`ignored` means the camera positions did not match the splat (another trainer moved the axes), and the
package fell back to framing the splat's dense body. Look at `preview.jpg`: it is drawn from the opening
view. If the floor is still not at the bottom, pass `--rotation` (degrees about x,y,z) as well, which
replaces the leveling but keeps the camera-based view.
