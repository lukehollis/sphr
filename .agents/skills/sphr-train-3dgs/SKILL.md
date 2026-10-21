---
name: sphr-train-3dgs
description: Train the Gaussian splat for a capture that has a COLMAP solve (photos, phone video, 360 frames cut into views, or an E57 scan's own photos) with nerfstudio's splatfacto, turning its appearance model on only when the exposure varied, Brush as the fallback; judge candidates on held-out photographs rather than PSNR and adopt one for packaging. Use for every splat the sphr-video skill trains, and whenever a trained splat shows mottled walls, blotchy ground, smeared sky or floaters.
---

# Training the splat

The splat is everything a visitor sees. Smears and floaters baked in at training cannot be fixed by framing
or packaging later, so train for appearance first. This skill is adapted from the real2sim project's
train-3dgs skill, which established the recipe below on handheld room captures.

Start from a COLMAP model the way sphr-video leaves it: `$SPHR_JOB_DIR/work/data/images/` (the frames COLMAP
used) and `$SPHR_JOB_DIR/work/data/sparse/0/`.

An **E57 scan with calibrated photos** (Matterport, Leica, NavVis, Faro) needs no COLMAP: its photos carry
exact poses and its laser points are a far better starting cloud than any reconstruction.

```sh
/opt/venv/bin/python scripts/packages/e57_to_colmap.py --input <scan.e57> --output "$SPHR_JOB_DIR/work/data"
```

It writes `work/data/images/` and `work/data/sparse/0/` in the scan's own axes, leaving out photos that look
straight down at the tripod. Several E57 files of one site (a Matterport export split into parts) share one
coordinate frame: convert each into its own folder and merge them, or train on the largest. Scanners change
exposure between positions, so train with the appearance model on (section 1).

Run every long step in the background with an exit file, as sphr-video describes; your commands stop after
10 minutes.

## 1. Choose the recipe from how the capture was exposed

```sh
/opt/venv/bin/python .agents/skills/sphr-train-3dgs/scripts/exposure_report.py "$SPHR_JOB_DIR/work/data/images" \
  [--originals "$SPHR_JOB_DIR/input/<photo folder>"]
```

Train with **splatfacto** (section 2) in every case; it was sharper than Brush on every capture compared
(below). What changes is the appearance model:

- `"exposure": "automatic"` (the photos' EXIF shows the shutter or ISO changing, as phone photos indoors
  and around windows do): **with** the appearance model, `--pipeline.model.use-bilateral-grid True`. Without
  it, exposure changes turn into blotches on flat surfaces.
- `"locked"`, or `"unknown"` for frames cut from a video or 360 footage: **without** it,
  `--pipeline.model.use-bilateral-grid False`. On a capture whose exposure barely changed, the appearance
  model has nothing to correct and drifts colour instead (a purple sky and pink-blotched walls on a sunny
  walkthrough). If the held-out sheets of this model then show patchy brightness on walls or floors,
  retrain with it.

Brush (sphr-video) is the fallback when `ns-train` is missing or the worker is short of time: about a
third of the time, softer distant detail, blotchier flat surfaces.

Measured on the RTX 3090 Ti, 30,000 iterations, held-out LPIPS (lower is better):

| Capture | Brush 15k | splatfacto with appearance | splatfacto without |
|---|---|---|---|
| Phone walkthrough, sunny, 108 frames | 0.256, smeared cliffs | 0.267, sharp but purple drift | **0.230**, sharp, true colour |
| Phone orbit indoors, 105 auto-exposed photos | 0.204, blotchy white table | **0.178**, clean table | not run |

splatfacto took 35 to 50 minutes on a busy worker (Brush 11 to 13), and wrote 100 to 350 MB.

## 2. splatfacto

```sh
cd "$SPHR_JOB_DIR/work"
(ns-train splatfacto --data data --output-dir ns --experiment-name scene --timestamp final \
   --vis tensorboard --viewer.quit-on-train-completion True --max-num-iterations 30000 \
   --pipeline.model.use-bilateral-grid <True|False> \
   --pipeline.model.camera-optimizer.mode SO3xR3 \
   --pipeline.model.use-scale-regularization True \
   --pipeline.model.rasterize-mode antialiased \
   --pipeline.model.stop-split-at 15000 \
   colmap --colmap-path sparse/0 --images-path images --downscale-factor 1 \
     --orientation-method none --center-method none --auto-scale-poses False \
     --assume-colmap-world-coordinate-convention False --eval-mode interval --eval-interval 8
 echo $? > ns.exit) > ns.log 2>&1 &
```

What each setting buys:

- `use-bilateral-grid` (True or False, section 1) gives every photograph its own colour and exposure
  correction, so geometry does not have to absorb exposure changes.
- `camera-optimizer.mode SO3xR3` refines each camera pose, absorbing COLMAP's residual pose error, which
  otherwise shows as doubled edges.
- `use-scale-regularization` penalizes long spiky Gaussians, which read as streaks.
- `rasterize-mode antialiased` filters each Gaussian at the pixel scale, so the result neither shimmers when
  far away nor aliases on a phone screen.
- `stop-split-at 15000` ends densification halfway, so the remaining iterations converge on a fixed set
  instead of growing more splats.
- The dataparser options keep COLMAP's own axes, so `build-splat.mjs --cameras` can open the space from a
  capture camera. `--eval-mode interval --eval-interval 8` holds back every eighth frame for judging (step 3).

Then export it:

```sh
ns-export gaussian-splat --load-config ns/scene/splatfacto/final/config.yml --output-dir splat-ns
```

`splat-ns/splat.ply` is a standard 3DGS PLY. The exporter drops Gaussians that are not finite or nearly
transparent, so it holds fewer than the trained count; that is expected.

Train each candidate under its own name (`--timestamp`, or a separate `--export-path` for Brush) and never
overwrite one you may adopt.

## 3. Judge on held-out photographs, not on PSNR

Render the held-back frames (every eighth image by name, the ones both trainers hold back) from each
candidate's exported PLY with the same renderer, and put the photograph beside them:

```sh
/opt/nerfstudio/bin/python .agents/skills/sphr-train-3dgs/scripts/render_views.py --ply splat-ns/splat.ply \
  --model data/sparse/0 --out renders/ns --antialiased
/opt/nerfstudio/bin/python .agents/skills/sphr-train-3dgs/scripts/render_views.py --ply splat/scene.ply \
  --model data/sparse/0 --out renders/brush
/opt/venv/bin/python .agents/skills/sphr-train-3dgs/scripts/compare_renders.py \
  --images data/images --render "splatfacto=renders/ns" --render "brush=renders/brush" --out compare
```

Pass `--antialiased` for a model trained with antialiased rasterization. Train Brush with
`--eval-split-every 8` and splatfacto with `--eval-mode interval --eval-interval 8` so the rendered frames are
ones neither model saw.

Then look at `compare/OVERVIEW.jpg` and a few single sheets. Judge large flat surfaces (ground, walls,
tables, sky) for blotches and smears, then the edges of thin things (columns, railings, plants) for floaters.
Reject a candidate with holes, doubled edges or drifting geometry, whatever its numbers say.

Read numbers with care. The bilateral grid corrects colour only while training, so held-out frames render
without their per-photo correction, and every frame shot at a different exposure scores a large colour
error: an appearance model loses PSNR and SSIM by construction even when every surface becomes clean.
Only LPIPS and the side-by-side sheets can rank it against a plain model. Expect the appearance model to
render a touch brighter and flatter than the auto-exposed photographs; that is the appearance model, not
geometry. Never tune settings by an evaluation number alone.

## 4. Adopt one and package it

First drop the splats no camera could see, which only show up as junk away from the capture path:

```sh
/opt/venv/bin/python scripts/packages/clean_splat.py --input <adopted.ply> --output splat-final.ply --model data/sparse/0
```

It leaves everything the cameras saw untouched (held-out renders match the uncleaned splat to within JPEG
noise). Do not strip large faint splats by hand: together they make up the sky and distant walls.

Package the adopted PLY with the cameras it was trained from, as sphr-video describes
(`build-splat.mjs --input <ply> --cameras "$SPHR_JOB_DIR/work/data/sparse/0"`), and check that the output's
`start.kind` is `orbit` or `walkthrough`. `ignored` means the splat's axes moved; for splatfacto that means
the dataparser options above were not used.

Keep the result under about 400 MB for phones. splatfacto at 30,000 iterations on a room usually lands near
one to two million splats; if the PLY is much larger, say so in the message rather than shipping a file a
phone cannot load.

## Rules

- Do not turn one capture's setting (iterations, thresholds, crop) into a default for every capture.
- Do not train both recipes on every job. Train the one the exposure evidence picks, and a second only
  when the held-out sheets show the defects the other recipe fixes.
- Tell the customer what was built in plain words; the recipe, iterations and metrics go in the progress
  log, not the message.
