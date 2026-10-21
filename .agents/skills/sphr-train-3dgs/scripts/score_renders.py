#!/opt/nerfstudio/bin/python
"""Scores held-out renders against their photographs: PSNR and LPIPS per candidate.

  /opt/nerfstudio/bin/python score_renders.py --images <frames> --render "brush=renders/brush" --render "ns=renders/ns"

Lower LPIPS is better and is the number to compare an appearance-model candidate with a plain one: PSNR
penalizes the per-photo exposure an appearance model deliberately leaves out of held-out renders. Use these
numbers beside the compare_renders.py sheets, never instead of them.
"""
import argparse
import json
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from torchmetrics.image.lpip import LearnedPerceptualImagePatchSimilarity

EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp'}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--images', required=True)
    parser.add_argument('--render', action='append', required=True, help='"<label>=<render folder>"')
    args = parser.parse_args()
    photos = {path.stem: path for path in Path(args.images).rglob('*') if path.suffix.lower() in EXTENSIONS}
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    lpips = LearnedPerceptualImagePatchSimilarity(normalize=True).to(device)
    report = {}
    for spec in args.render:
        label, _, folder = spec.rpartition('=')
        psnrs, perceptual = [], []
        for render in sorted(path for path in Path(folder).rglob('*') if path.suffix.lower() in EXTENSIONS):
            if render.stem not in photos:
                continue
            ours = Image.open(render).convert('RGB')
            truth = Image.open(photos[render.stem]).convert('RGB').resize(ours.size, Image.Resampling.LANCZOS)
            a, b = (np.asarray(image, dtype=np.float32) / 255 for image in (ours, truth))
            psnrs.append(float(10 * np.log10(1 / max(((a - b) ** 2).mean(), 1e-10))))
            with torch.no_grad():
                pair = [torch.tensor(x).permute(2, 0, 1)[None].to(device) for x in (a, b)]
                perceptual.append(float(lpips(*pair)))
        report[label or folder] = {'views': len(psnrs), 'psnr': round(float(np.mean(psnrs)), 2) if psnrs else None,
                                   'lpips': round(float(np.mean(perceptual)), 4) if perceptual else None}
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
