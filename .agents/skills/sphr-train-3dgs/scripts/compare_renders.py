#!/usr/bin/env python3
"""Lays held-out photographs beside renders from one or more trained splats, so candidates can be judged
by eye on the same frames. Adapted from the real2sim project's assemble_3dgs_compare.py.

  compare_renders.py --images <frames the model trained from> \\
      --render "splatfacto appearance=<render folder>" [--render "brush=<render folder>"] \\
      --out <folder> [--overview-count 6]

Renders are found anywhere under each render folder (ns-render puts them in <folder>/test/rgb/) and matched
to photographs by file name without extension. The photo column is always the original frame, never a
trainer's own "ground truth" output, whose colours are not reliable. Writes one PHOTO | A | B sheet per
held-out frame and OVERVIEW.jpg with a few frames spread across the capture.
"""
import argparse
from pathlib import Path

from PIL import Image, ImageDraw

EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp'}


def by_stem(folder):
    return {path.stem: path for path in sorted(Path(folder).rglob('*')) if path.suffix.lower() in EXTENSIONS}


def labelled(image, text):
    image = image.copy()
    draw = ImageDraw.Draw(image)
    draw.rectangle([0, 0, image.width, 36], fill=(0, 0, 0))
    draw.text((10, 10), text, fill=(255, 255, 0))
    return image


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--images', required=True)
    parser.add_argument('--render', action='append', required=True, help='"<label>=<render folder>"; repeat for each candidate')
    parser.add_argument('--out', required=True)
    parser.add_argument('--overview-count', type=int, default=6)
    parser.add_argument('--width', type=int, default=960, help='Width of each panel')
    args = parser.parse_args()

    photos = by_stem(args.images)
    candidates = []
    for spec in args.render:
        label, _, folder = spec.rpartition('=')
        renders = by_stem(folder)
        if not renders:
            raise SystemExit(f'No renders under {folder}.')
        candidates.append((label or folder, renders))
    names = sorted(set(photos).intersection(*(set(renders) for _, renders in candidates)))
    if not names:
        raise SystemExit('The renders share no file names with the photographs; render the held-out split by image name.')
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    written = []
    for index, name in enumerate(names):
        panels = [(Image.open(photos[name]).convert('RGB'), f'PHOTO {name}')]
        panels += [(Image.open(renders[name]).convert('RGB'), label) for label, renders in candidates]
        base = panels[0][0]
        height = round(base.height * args.width / base.width)
        tiles = [labelled(image.resize((args.width, height)), text) for image, text in panels]
        sheet = Image.new('RGB', (len(tiles) * args.width + 12 * (len(tiles) - 1), height), (0, 0, 0))
        for position, tile in enumerate(tiles):
            sheet.paste(tile, (position * (args.width + 12), 0))
        path = out / f'{index:03d}_{name}.jpg'
        sheet.save(path, quality=90)
        written.append(path)

    count = min(args.overview_count, len(written))
    picks = sorted({round(i * (len(written) - 1) / max(1, count - 1)) for i in range(count)})
    rows = [Image.open(written[i]) for i in picks]
    for row in rows:
        row.thumbnail((2400, 900))
    overview = Image.new('RGB', (max(row.width for row in rows), sum(row.height for row in rows) + 10 * (len(rows) - 1)), (0, 0, 0))
    top = 0
    for row in rows:
        overview.paste(row, (0, top))
        top += row.height + 10
    overview.save(out / 'OVERVIEW.jpg', quality=88)
    print(f'Wrote {len(written)} comparison sheets and OVERVIEW.jpg to {out}')


if __name__ == '__main__':
    main()
