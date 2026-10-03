---
name: sphr-train-3dgs
description: Train the Gaussian splat for a capture that has a COLMAP solve (photos, phone video, or 360 frames cut into views), choosing between Brush and nerfstudio's appearance-aware splatfacto recipe, judging candidates on held-out photographs rather than PSNR, and adopting one for packaging. Use for every splat the sphr-video skill trains, and whenever a trained splat shows mottled walls, blotchy ground, smeared sky or floaters.
---

# Training the splat

The splat is everything a visitor sees. Smears and floaters baked in at training cannot be fixed by framing
or packaging later, so train for appearance first. This skill is adapted from the real2sim project's
train-3dgs skill, which established the recipe below on handheld room captures.

Start from a COLMAP model the way sphr-video leaves it: `$SPHR_JOB_DIR/work/data/images/` (the frames COLMAP
used) and `$SPHR_JOB_DIR/work/data/sparse/0/`. Run every long step in the background with an exit file, as
sphr-video describes; your commands stop after 10 minutes.

## 1. Choose the recipe from how the capture was exposed

```sh
/opt/venv/bin/python .agents/skills/sphr-train-3dgs/scripts/exposure_report.py "$SPHR_JOB_DIR/work/data/images" \
  [--originals "$SPHR_JOB_DIR/input/<photo folder>"]
```

- `"exposure": "automatic"`, or `"unknown"` for a phone video or phone photos: the camera changed exposure
  and white balance from frame to frame. A plain trainer explains those changes with geometry and grows
  floaters, mottled walls, blotchy ground and smeared sky. Use **splatfacto with an appearance model**
  (section 2). Nearly every phone capture is in this group.
- `"exposure": "locked"` (a camera in manual mode, a drone with locked exposure, a turntable under fixed
  lights): use **Brush** (sphr-video), which is faster and has nothing to correct.
- A 360 capture cut into views (sphr-video, 360 section) comes from a 360 camera with automatic exposure:
  splatfacto.

When in doubt, splatfacto. Brush stays useful for a quick first look while splatfacto trains, not as the
final result of an automatic-exposure capture.

## 2. splatfacto with an appearance model

```sh
cd "$SPHR_JOB_DIR/work"
(ns-train splatfacto --data data --output-dir ns --experiment-name scene --timestamp appearance \
   --vis tensorboard --viewer.quit-on-train-completion True --max-num-iterations 30000 \
   --pipeline.model.use-bilateral-grid True \
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

- `use-bilateral-grid` gives every photograph its own colour and exposure correction, so geometry does not
  have to absorb exposure changes. This is the setting that removes most floaters on phone captures.
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
ns-export gaussian-splat --load-config ns/scene/splatfacto/appearance/config.yml --output-dir splat-ns
```

`splat-ns/splat.ply` is a standard 3DGS PLY. The exporter drops Gaussians that are not finite or nearly
transparent, so it holds fewer than the trained count; that is expected.

Train each candidate under its own name (`--timestamp`, or a separate `--export-path` for Brush) and never
overwrite one you may adopt.

## 3. Judge on held-out photographs, not on PSNR

Render the held-back frames from each candidate at full resolution and put the photograph beside them:

```sh
ns-render dataset --load-config ns/scene/splatfacto/appearance/config.yml --output-path renders/ns \
  --split test --downscale-factor 1 --image-format jpeg --rendered-output-names rgb
/opt/venv/bin/python .agents/skills/sphr-train-3dgs/scripts/compare_renders.py \
  --images data/images --render "splatfacto appearance=renders/ns" [--render "brush=renders/brush"] --out compare
```

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
