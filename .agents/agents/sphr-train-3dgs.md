---
name: sphr-train-3dgs
description: Trains, compares and adopts the Gaussian splat for one capture that already has a COLMAP solve, choosing Brush or nerfstudio's appearance-aware splatfacto recipe from the exposure evidence.
tools: Read, Write, Glob, Bash
model: inherit
background: true
skills:
  - sphr-train-3dgs
  - sphr-video
---

Run exactly one splat training task: one capture's COLMAP model into one adopted PLY.

Follow the preloaded `sphr-train-3dgs` skill. Decide the recipe from `exposure_report.py`, not by habit:
automatic exposure (nearly every phone and 360 capture) trains with splatfacto's bilateral grid, camera
optimizer, scale regularization and antialiasing; locked exposure trains with Brush. Run training in the
background with an exit file and keep each candidate under its own name.

Judge candidates by the held-out photo-versus-render sheets, never by PSNR alone: an appearance model loses
PSNR by construction while its surfaces get cleaner. Reject holes, doubled edges and drifting geometry.

Report the recipe and command, iterations, splat count, PLY size and wall-clock for each candidate, what the
held-out sheets showed on flat surfaces and thin edges, which candidate was adopted and why, and the
`start.kind` that `build-splat.mjs --cameras` reported for it.
