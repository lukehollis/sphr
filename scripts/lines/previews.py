#!/usr/bin/env python3
"""Preview JPEGs for a line-drawing splat set (run after splats.sh has rendered views).

  python3 previews.py --root <work>/<slug> --out <work>/<slug>/out

Expects <root>/{color,contour,watercolor}/images/ (the three training sets) and
<root>/renders/<style>/<stem>.jpg (each splat rendered from a capture camera by the
worker's render_views.py). Writes
  preview-inputs.jpg       one training photo, its line drawing and its watercolor
  preview-<style>.jpg      that style's training image (left) beside the splat's render (right)
"""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np

STYLES = ("color", "contour", "watercolor")


def at_height(img: np.ndarray, h: int) -> np.ndarray:
    return cv2.resize(img, (round(img.shape[1] * h / img.shape[0]), h), interpolation=cv2.INTER_AREA)


def side_by_side(imgs, h: int, gap: int = 8) -> np.ndarray:
    tiles = [at_height(i, h) for i in imgs]
    pad = np.full((h, gap, 3), 255, np.uint8)
    row = [tiles[0]]
    for t in tiles[1:]:
        row += [pad, t]
    return np.hstack(row)


def find_image(folder: Path, stem: str) -> Path:
    for p in sorted(folder.iterdir()):
        if p.stem == stem:
            return p
    raise FileNotFoundError(f"{stem} in {folder}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--height", type=int, default=720)
    a = ap.parse_args()
    root, out = Path(a.root), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    renders = sorted((root / "renders" / "color").glob("*.jpg"))
    stem = renders[0].stem if renders else sorted((root / "color" / "images").iterdir())[0].stem
    inputs = [cv2.imread(str(find_image(root / s / "images", stem))) for s in STYLES]
    cv2.imwrite(str(out / "preview-inputs.jpg"), side_by_side(inputs, a.height // 2), [cv2.IMWRITE_JPEG_QUALITY, 88])
    for s, train in zip(STYLES, inputs):
        r = root / "renders" / s / f"{stem}.jpg"
        if not r.exists():
            continue
        cv2.imwrite(str(out / f"preview-{s}.jpg"), side_by_side([train, cv2.imread(str(r))], a.height),
                    [cv2.IMWRITE_JPEG_QUALITY, 88])
    print(f"previews for {stem} in {out}")


if __name__ == "__main__":
    main()
