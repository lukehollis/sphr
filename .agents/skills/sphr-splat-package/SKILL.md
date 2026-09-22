---
name: sphr-splat-package
description: Package an uploaded 3D Gaussian splat (PLY, SPZ, SPLAT, KSPLAT, SOG) as a hosted SPHR space, choosing the orientation and opening view so the capture appears upright and framed.
---

# Gaussian splat packages

Spark renders `.ply` (3DGS with `f_dc_*`, `opacity`, `scale_*`, `rot_*`), `.spz`, `.splat`, `.ksplat`
and `.sog` directly. Exports from Polycam, Luma, Scaniverse, Postshot, gsplat, nerfstudio and Brush all work.

```sh
node scripts/packages/build-splat.mjs --input "<file>" --title "<title>"
```

Options:

- `--rotation x,y,z` in degrees. Trainers that use COLMAP's axes (y down, z forward) need `180,0,0`.
  Look at `preview.jpg`: the floor or ground must be at the bottom.
- `--interior` opens standing inside the capture (rooms, buildings you walk through) instead of orbiting
  it from outside (objects, statues, exteriors, drone captures).
- `--elevation 25` sets how steeply the opening orbit looks down (degrees).

The tool copies the file unchanged, estimates bounds from a sample (ignoring stray floaters), renders
`preview.jpg` and writes the package. `.spz`, `.sog` and `.ksplat` cannot be sampled, so their preview is a
title card and the opening view is generic; say so in your message and suggest the customer sets the
start view with **Edit**. A legacy compressed `.splat` that Spark cannot read can be converted first:
`node scripts/convert-legacy-splat.mjs <in> <out.splat>`.

Several splats of the same place: package the largest or most complete one. Very large files (over
~1.5 GB) load slowly on phones; mention that in your message.
