---
name: capture-phone-keyframe-export
description: Phone capture-app export ZIP with keyframes/images (HEIF), keyframes/cameras (per-frame JSON) and keyframes/gravity, optionally with a lidar preview video; recognize it and prepare it for splat training.
learned: 2026-10-03 from processing job f64fc7424a032d18, reviewed (runner after review)
---

# Phone keyframe export

## Recognize
ZIP containing `keyframes/images/<timestamp>.heif`, `keyframes/cameras/<timestamp>.json`, `keyframes/gravity/<timestamp>.json`. inspect-inputs lists the JSON as `unknown` and the HEIF files may show as photos but Pillow needs `pillow_heif.register_heif_opener()` to open them.

## Read the data
- Camera JSON holds a 3x3 rotation (`t_00`..`t_22`), zero translation (`t_03`, `t_13`, `t_23`), normalized and sign-flipped intrinsics, `blur_score`, and gravity. Translations of zero mean poses were not exported; do not trust the intrinsics either.
- View the images: if they show one object from many sides it is an orbit, so use photogrammetry (sphr-video skill): convert HEIF to downscaled JPEG (about 1200 px long side), then COLMAP.
- A companion MP4 of a coloured, orbiting 3D reconstruction on a plain background is a preview render, not capture data; do not reconstruct from it.

## Steps
1. Convert HEIF to JPEG with Pillow and pillow_heif into `work/frames`.
2. `mkdir work/colmap` first (COLMAP aborts if the workspace dir is missing), then run `automatic_reconstructor` as in sphr-video with `--quality low --use_gpu 0`. 105 frames register in about 10 s.
3. Training needs a GPU trainer; if none is installed, stop as sphr-video describes.

## Check
`colmap model_analyzer --path work/colmap/sparse/0`: registered images and reprojection error under about 1.5 px.
