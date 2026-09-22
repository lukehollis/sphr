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

The tool levels the capture automatically: it finds the ground plane in the dense part of the
splat (ignoring stray floaters) and turns it horizontal, with up on the side the scene rises into.
It frames the opening orbit on the dense body of the capture. Check `preview.jpg`: the ground must be
at the bottom and the subject in view. If it is not:

- `--rotation x,y,z` in degrees replaces the automatic leveling (for example `180,0,0` for an upside-down
  COLMAP-frame export when there is no clear ground). `--no-level` keeps the file's own axes.
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
