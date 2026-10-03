---
name: sphr-panorama-package
description: Package 360 photos or 360 video as a hosted SPHR panorama tour, one stop per photo or sampled frame, with a guided Previous/Next tour.
---

# 360 photo and video packages

## Photos

Equirectangular photos are 2:1 (for example 5760×2880 from an Insta360 or 5376×2688 from a Ricoh Theta).
Insta360 originals (`.insv`, `.insp`) are unstitched fisheye; build them with `build-insta360.mjs` below
instead of asking the customer to export from the Insta360 app.

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

## Insta360 originals (`.insv` video, `.insp` stills)

Customers' agents often upload straight from the camera's SD card. Stitch here; never send them to
Insta360 Studio when the raw files are present.

```sh
node scripts/packages/build-insta360.mjs --input "$SPHR_JOB_DIR/input" --title "<title>" [--every 2.5] [--max-frames 40]
```

- **Files.** The ONE RS 1-Inch records each video as two files, one per lens: `VID_<date>_<time>_00_<n>.insv`
  and `VID_<date>_<time>_10_<n>.insv`. ONE X-series clips hold both lenses in one file; both work.
  `LRV_` files are the camera's low-resolution previews and are ignored. `.insp` stills hold both lenses in
  one image; exposures that share a timestamp are an HDR bracket and the most evenly exposed one is used.
- **A missing lens.** If the output lists a video under `skipped` because only one lens arrived, report
  `failed` and name the missing file (the same name with `_10_` instead of `_00_`, or the reverse).
- **Trim.** The camera's IMU cuts the stand being lifted at the start and lowered at the end (`trim: imu`
  in the output); `--start`/`--end` override it. Use `--every 1.5` in tight corridors, tombs or on stairs.
- **Orientation.** Sky must be at the top of `preview.jpg`. If it is upside down the camera was mounted
  inverted: rebuild with `--roll 0`. A faint hard seam a quarter of the way in from each side, and the
  person holding the camera at the very bottom, are expected from this stitch.

## Check

Open `preview.jpg`: it shows the middle of the first photo and must be upright. Report how many stops the
tour has.
