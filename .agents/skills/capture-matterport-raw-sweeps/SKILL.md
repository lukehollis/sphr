---
name: capture-matterport-raw-sweeps
description: Matterport Capture app job folder (metafile.json beside a folder whose SweepProcessorData/ holds manifest.mfst, <sweep>_512_00N.jpg cube faces, *_sweep_cloud.pb and *.dam), usually zipped from the iPad or iPhone, with no E57. Import it as a measured space, every aligned sweep at its position with a fused mesh and navigation, the way a Matterport E57 import comes out.
---

# Matterport Capture app job folder

## Recognize
A ZIP or folder with `metafile.json` (`platform`, `app_version`) and one UUID-named job folder holding
`<UUID>.swl` files, `Floor1-thumb.png` and `SweepProcessorData/`: `manifest.mfst`, `<sweep>_512_00{0-5}.jpg`
(also `_256_`, `_128_` and `_skybox{0-5}`), `<sweep-uuid>_sweep_cloud.pb`, `<sweep-uuid>_sweep_features.pb`,
`<sweep>.dam` and `.mmp` files. There is no E57, so sphr-matterport does not apply, but the same measured data
is here: `manifest.mfst` holds every sweep's alignment pose, the clouds are the depth camera's points, and the
DAM texture coordinates calibrate the cube faces.

## Build
Unzip into `work/`, then from the repository root (`/opt/sphr` in the worker sandbox):

```sh
node scripts/matterport/import-capture.mjs --job "$SPHR_JOB_DIR/work/<unzipped folder>" \
  --slug "$SPHR_SCENE_SLUG" --title "<title from job.json>" --public-root "$SPHR_JOB_DIR/output/public"
```

It places each aligned sweep at its measured pose with its six faces, fuses the point clouds into a textured
50k-triangle mesh, finds the floor under each camera, links sweeps that see each other, and writes the package,
`validation.json` and `preview.jpg`. Forty sweeps take a few minutes; run it in the background and poll, since
commands stop after 10 minutes. Sweeps the app could not align (`EOS:Failed to align`) have no position: the
importer leaves them out and lists them under `unalignedSweeps` in `manifest.json`. This is the tour for both
`"tour"` and `"auto"`.

## Check
Read the printed summary: sweeps placed and left out, links and connected areas, floors measured. Look at
`preview.jpg` and validate as sphr-intake section 3 says. More than one connected area means visitors cannot
walk between those parts; mention it when more than a stray sweep is cut off.

## Limits
The app keeps only 512 px faces (Matterport renders full resolution in its cloud), so the panoramas are soft;
say so plainly. These previews are too soft for a splat: for `"splat"`, build the tour and explain why. Sweeps
without depth points are placed but add no surface. If the importer finds no aligned sweep, or no depth points at
all (it says to build a panorama tour), fall back to a tour without positions:
`/opt/venv/bin/python -I .agents/skills/capture-matterport-raw-sweeps/scripts/cube2equi.py <SweepProcessorData> <outdir> 1024`
then package `<outdir>` with sphr-panorama-package.
