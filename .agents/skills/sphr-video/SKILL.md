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
mkdir -p "$SPHR_JOB_DIR/work/colmap"   # COLMAP aborts with a stack trace if the workspace does not exist
(QT_QPA_PLATFORM=offscreen colmap automatic_reconstructor --workspace_path "$SPHR_JOB_DIR/work/colmap" \
  --image_path "$SPHR_JOB_DIR/work/frames" --dense 0 --single_camera 1 --quality medium --use_gpu 0 \
  --data_type video; echo $? > "$SPHR_JOB_DIR/work/colmap.exit") > "$SPHR_JOB_DIR/work/colmap.log" 2>&1 &
# --data_type video: frames from one video; use --data_type individual for a set of photos
```

Matching runs on the CPU, so pick the matcher by where the frames came from. `video` matches each frame
with its neighbours (about 4 s a frame for 108 frames at 1600 px, so 8 minutes); `individual` matches every
pair, which suits orbit photo sets up to about 150 but took 6.5 minutes per block of a 108-frame video. Run
COLMAP in the background as above and check on it (it is finished when `work/colmap.exit` exists, holding
its exit code), rather than letting a command time out and starting over.

COLMAP here is built without CUDA: its default GPU SIFT crashes with a stack trace, so keep `--use_gpu 0`
(for the step-by-step commands, `--SiftExtraction.use_gpu 0` and `--SiftMatching.use_gpu 0`). Phone
captures are often HEIC; convert frames to JPEG first with Pillow and `pillow_heif`.

Check `work/colmap/sparse/0` exists and most frames registered (`colmap model_analyzer --path work/colmap/sparse/0`).
When the walk loses track (fast turns, blank walls), COLMAP starts over and writes several models
(`sparse/0`, `sparse/1`, …) in the order it built them, not by size. Run `model_analyzer` on each and train
on the one with the most registered images; tell the customer if a large part of the video was left out.

## 2b. 360 photos and 360 video as a splat

When the customer wants a splat from a 360 capture (sphr-intake, section 2), get equirectangular frames
first, then cut each into perspective views, which COLMAP and the trainers need:

- 360 video: `ffmpeg -i <video> -vf fps=2 -q:v 2 "$SPHR_JOB_DIR/work/pano/%05d.jpg"` (2 frames a second of
  walking is about right; more for a fast walk).
- 360 photos: copy them into `work/pano/` in capture order (file names or EXIF time).
- Raw Insta360 files: build the tour with `build-insta360.mjs` first (sphr-panorama-package); its stitched
  panoramas in the package's `pano/` folder are the frames. Copy them out before building the splat, which
  replaces the package. The tour is also your fallback if reconstruction fails.

```sh
/opt/venv/bin/python scripts/packages/pano_views.py --input "$SPHR_JOB_DIR/work/pano" \
  --output "$SPHR_JOB_DIR/work/data/images" --views 8 --fov 90 --size 1280
```

It prints the shared pinhole camera (`cameraParams`). Views stay level, so the selfie stick, tripod and
photographer below the camera are left out; add `--up-ring 4` for ceilings and tree canopies. Run COLMAP
step by step with that camera fixed, in the background as in section 2:

```sh
cd "$SPHR_JOB_DIR/work" && mkdir -p colmap/sparse && export QT_QPA_PLATFORM=offscreen
(colmap feature_extractor --database_path colmap/db.db --image_path data/images --ImageReader.camera_model PINHOLE \
   --ImageReader.single_camera 1 --ImageReader.camera_params "<cameraParams>" --SiftExtraction.use_gpu 0 \
 && colmap sequential_matcher --database_path colmap/db.db --SiftMatching.use_gpu 0 --SequentialMatching.overlap 24 \
 && colmap mapper --database_path colmap/db.db --image_path data/images --output_path colmap/sparse \
      --Mapper.ba_refine_focal_length 0 --Mapper.ba_refine_principal_point 0 --Mapper.ba_refine_extra_params 0
 echo $? > colmap.exit) > colmap.log 2>&1 &
```

The overlap of 24 is three frames' worth of 8 views, so each view is matched with the same direction in the
neighbouring frames; for photos taken far apart use `colmap exhaustive_matcher` instead. Measured: 36 frames of
an 18-second 360 walk (288 views at 1024 px) registered completely in one model, 1.1 px reprojection error.
When less than about two thirds of the views register, build the tour instead (sphr-intake). Otherwise copy
`colmap/sparse/0` to `data/sparse/0` and train as below; a 360 camera exposes automatically, so follow
sphr-train-3dgs's appearance recipe.

## 3. Train and package

Which trainer and settings to use, and how to judge the result, is in the **sphr-train-3dgs** skill; read it
before training. Brush, below, is the fast trainer for captures with locked exposure.

**Brush** is installed on GPU workers (`SPHR_GPU=nvidia` is set and `brush_app` exists). It trains on the GPU
and reads a folder that holds `images/` and `sparse/0/` side by side, so copy COLMAP's model next to the
frames it used:

```sh
mkdir -p "$SPHR_JOB_DIR/work/data/sparse"
cp -r "$SPHR_JOB_DIR/work/colmap/sparse/0" "$SPHR_JOB_DIR/work/data/sparse/0"   # work/data/images = the frames COLMAP used
(brush_app "$SPHR_JOB_DIR/work/data" --total-steps 15000 --max-splats 1500000 --eval-split-every 8 --export-path "$SPHR_JOB_DIR/work/splat" \
  --export-name scene.ply --export-every 5000; echo $? > "$SPHR_JOB_DIR/work/brush.exit") > "$SPHR_JOB_DIR/work/brush.log" 2>&1 &
```

Your commands stop after 10 minutes, and training (like COLMAP on a long video) can take longer when the
worker is busy, so never run it in the foreground or under a short `timeout`: a killed run leaves nothing.
Start it as above and check every minute or two whether `work/brush.exit` exists (it holds the exit code).
Do not test the process with `kill -0`: a finished background job stays a zombie of your shell and still
answers.
`--export-every 5000` rewrites `scene.ply` along the way, so a run that has to be stopped still leaves a
usable splat; package only after the process has finished. `--max-splats 1500000` keeps the PLY under about
400 MB: Brush's own limit is 10 million, and a 108-frame walkthrough grew to 3.7 million splats (870 MB),
too much for a phone to download.

Measured on the RTX 3090 Ti: 105 photos at 1600 px register in COLMAP (CPU) in about 4 minutes and
train 15,000 steps in about 8.5 minutes, giving a ~100 MB PLY; a 108-frame walkthrough took about 12 minutes
in COLMAP while the worker was busy and 8 minutes to train, giving a 354 MB PLY at the splat cap. Write a progress line before training
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
