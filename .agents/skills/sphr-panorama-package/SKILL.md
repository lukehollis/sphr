---
name: sphr-panorama-package
description: Package 360 photos or 360 video as a hosted SPHR panorama tour, one stop per photo or sampled frame, with a guided Previous/Next tour.
---

# 360 photo and video packages

## Photos

Equirectangular photos are 2:1 (for example 5760×2880 from an Insta360 or 5376×2688 from a Ricoh Theta).
Cameras that export dual-fisheye originals (`.insp`, side-by-side circles) must be stitched first; if only
fisheye files arrived, report `failed` and ask for the stitched 360 JPGs from the camera's app.

```sh
node scripts/packages/build-panoramas.mjs --input "$SPHR_JOB_DIR/input" --title "<title>" [--captions]
```

Photos are ordered by file name (camera numbering is usually capture order), resized to at most 8192 px
wide and stored flipped to suit the viewer's sphere; each opens facing the photo's center. Images that are
not 2:1 are skipped and listed in the output; mention skipped files in your message. `--captions` shows
each file name as the tour text; use it only when names are meaningful ("Kitchen", "Stair hall").

## 360 video

```sh
node scripts/packages/build-video360.mjs --input "<video>" --title "<title>" [--every 3] [--max-frames 40] [--start 5] [--end 120]
```

A frame every 2–4 seconds suits walking pace; `--max-frames` caps the tour length. Trim a shaky start or end
with `--start` and `--end` (seconds). The video must be 2:1 equirectangular. Ordinary (flat) video belongs
to the sphr-video skill.

## Check

Open `preview.jpg`: it shows the middle of the first photo and must be upright. Report how many stops the
tour has.
