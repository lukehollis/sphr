#!/usr/bin/env python3
"""Machine line drawings for Spacery.

Reproduces the method of https://amritkwatra.com/experiments/3d-line-drawings
(splatline, MIT): every photo goes through Chan, Isola and Durand's
"informative-drawings" generator (contour style), and the "watercolor" look is
the line drawing multiplied over a blurred, saturation-boosted copy of the photo.

The generator below is a verbatim port of ``Generator`` in
github.com/carolineec/informative-drawings/model.py (MIT, Copyright (c) 2022
Caroline Chan, commit 2349aee). Inference matches that repo's test.py and
splatline/stages/stylize.py: RGB in [0, 1] (ToTensor, no mean/std
normalisation), single-channel sigmoid output, white paper and dark ink.
The watercolor blend is splatline/effects/blend.py (sigma 8, saturation x1.3).

Weights: scripts/lines/fetch_weights.sh puts <style>_style/netG_A_latest.pth
under a weights directory (Google Drive id 1MIdHzecxz-z0uY3ARL_R40DlKcuQxiDk).

Sub-commands
  stylize   turn a folder of images into contour and watercolor folders
            (same file names, same pixel size unless --size is given)
  faces     download the six 1024 px cube faces for a Spacery panorama scene
  panos     faces + stylize + index.json for one scene, ready to upload

Requires torch, numpy and opencv-python (torchvision is not needed).
Runs on CUDA, Apple MPS or CPU (picked automatically, override with --device).
"""

from __future__ import annotations

import argparse
import concurrent.futures as futures
import json
import os
import sys
import time
import urllib.request
from pathlib import Path
from typing import List, Optional, Sequence

import cv2
import numpy as np

CATALOG_URL = "https://static.mused.com/sphr/datasets/matterport/index.json"
PUBLIC_BASE = "https://storage.googleapis.com/spacery-static/sphr/lines"
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}


# --------------------------------------------------------------------------
# informative-drawings generator (port of model.py, MIT, Caroline Chan 2022)
# --------------------------------------------------------------------------

def build_generator(n_residual_blocks: int = 3):
    """Generator(input_nc=3, output_nc=1, n_blocks=3) exactly as test.py builds it."""
    import torch.nn as nn

    norm_layer = nn.InstanceNorm2d  # affine=False, no running stats: nothing to load

    class ResidualBlock(nn.Module):
        def __init__(self, in_features):
            super().__init__()
            self.conv_block = nn.Sequential(
                nn.ReflectionPad2d(1),
                nn.Conv2d(in_features, in_features, 3),
                norm_layer(in_features),
                nn.ReLU(inplace=True),
                nn.ReflectionPad2d(1),
                nn.Conv2d(in_features, in_features, 3),
                norm_layer(in_features),
            )

        def forward(self, x):
            return x + self.conv_block(x)

    class Generator(nn.Module):
        def __init__(self, input_nc=3, output_nc=1, n_blocks=3):
            super().__init__()
            self.model0 = nn.Sequential(
                nn.ReflectionPad2d(3), nn.Conv2d(input_nc, 64, 7), norm_layer(64), nn.ReLU(inplace=True)
            )
            m1, f = [], 64
            for _ in range(2):
                m1 += [nn.Conv2d(f, f * 2, 3, stride=2, padding=1), norm_layer(f * 2), nn.ReLU(inplace=True)]
                f *= 2
            self.model1 = nn.Sequential(*m1)
            self.model2 = nn.Sequential(*[ResidualBlock(f) for _ in range(n_blocks)])
            m3 = []
            for _ in range(2):
                m3 += [
                    nn.ConvTranspose2d(f, f // 2, 3, stride=2, padding=1, output_padding=1),
                    norm_layer(f // 2),
                    nn.ReLU(inplace=True),
                ]
                f //= 2
            self.model3 = nn.Sequential(*m3)
            self.model4 = nn.Sequential(nn.ReflectionPad2d(3), nn.Conv2d(64, output_nc, 7), nn.Sigmoid())

        def forward(self, x):
            return self.model4(self.model3(self.model2(self.model1(self.model0(x)))))

    return Generator(3, 1, n_residual_blocks)


def pick_device(preferred: Optional[str] = None) -> str:
    import torch

    if preferred:
        return preferred
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def load_model(weights_dir: Path, style: str = "contour", device: Optional[str] = None):
    import torch

    ckpt = Path(weights_dir) / f"{style}_style" / "netG_A_latest.pth"
    if not ckpt.exists():
        sys.exit(f"missing weights {ckpt}; run scripts/lines/fetch_weights.sh {weights_dir}")
    device = pick_device(device)
    net = build_generator()
    net.load_state_dict(torch.load(ckpt, map_location="cpu"))
    return net.to(device).eval(), device


def run_model(net, device: str, rgb_batch: Sequence[np.ndarray]) -> List[np.ndarray]:
    """RGB uint8 HxWx3 images (all the same size) -> grayscale uint8 HxW line drawings."""
    import torch

    x = np.stack(rgb_batch).astype(np.float32) / 255.0  # ToTensor: [0, 1], no normalisation
    t = torch.from_numpy(x).permute(0, 3, 1, 2).contiguous().to(device)
    with torch.no_grad():
        y = net(t)[:, 0].clamp(0, 1)
    y = (y * 255.0 + 0.5).to(torch.uint8).cpu().numpy()
    return [y[i] for i in range(y.shape[0])]


# --------------------------------------------------------------------------
# watercolor blend (splatline/effects/blend.py)
# --------------------------------------------------------------------------

def watercolor_blend(color_bgr: np.ndarray, line: np.ndarray, sigma_low: float = 8.0,
                     color_strength: float = 1.3) -> np.ndarray:
    """Ink lines multiplied over a soft, saturation-boosted Gaussian low-pass of the photo."""
    color = color_bgr.astype(np.float32) / 255.0
    lines = line.astype(np.float32) / 255.0
    if lines.ndim == 2:
        lines = lines[:, :, None]
    wash = cv2.GaussianBlur(color, (0, 0), sigmaX=sigma_low, sigmaY=sigma_low)
    if color_strength != 1.0:
        hsv = cv2.cvtColor(np.clip(wash, 0, 1), cv2.COLOR_BGR2HSV)
        hsv[:, :, 1] = np.clip(hsv[:, :, 1] * color_strength, 0, 1)
        wash = cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR)
    out = np.clip(wash * lines, 0.0, 1.0)
    return (out * 255.0).astype(np.uint8)


# --------------------------------------------------------------------------
# stylize a folder
# --------------------------------------------------------------------------

def list_images(folder: Path) -> List[Path]:
    return sorted(p for p in Path(folder).rglob("*") if p.suffix.lower() in IMAGE_EXTS and p.is_file())


def read_rgb(path: Path, size: Optional[int]) -> np.ndarray:
    bgr = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if bgr is None:
        raise ValueError(f"cannot read {path}")
    if size and (bgr.shape[0] != size or bgr.shape[1] != size):
        interp = cv2.INTER_AREA if bgr.shape[0] > size else cv2.INTER_CUBIC
        bgr = cv2.resize(bgr, (size, size), interpolation=interp)
    return bgr


def write_jpeg(path: Path, img: np.ndarray, quality: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if img.ndim == 2:  # write 3-channel so every consumer (browsers, Brush, COLMAP) is happy
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    ok = cv2.imwrite(str(path), img, [cv2.IMWRITE_JPEG_QUALITY, quality, cv2.IMWRITE_JPEG_OPTIMIZE, 1])
    if not ok:
        raise IOError(f"failed to write {path}")


def write_image(path: Path, img: np.ndarray, quality: int) -> None:
    if path.suffix.lower() in (".jpg", ".jpeg"):
        write_jpeg(path, img, quality)
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        if img.ndim == 2:
            img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
        cv2.imwrite(str(path), img)


def fit_side(img: np.ndarray, max_side: int) -> np.ndarray:
    h, w = img.shape[:2]
    if not max_side or max(h, w) <= max_side:
        return img
    k = max_side / max(h, w)
    return cv2.resize(img, (max(1, round(w * k)), max(1, round(h * k))), interpolation=cv2.INTER_AREA)


def stylize_pairs(pairs: Sequence[tuple], net, device: str, size: Optional[int], quality: int,
                  batch: int, skip_existing: bool = True, log_every: int = 60, max_side: int = 0) -> int:
    """pairs = [(src, contour_dst, watercolor_dst_or_None)]. Returns how many were written.

    size     resize every input to size x size first (panorama faces: 1024)
    max_side otherwise images whose long side exceeds this are drawn at that size and the
             drawing is scaled back up, so outputs always match the input's pixel size
    """
    todo = [p for p in pairs if not (skip_existing and Path(p[1]).exists() and (p[2] is None or Path(p[2]).exists()))]
    t0, done = time.time(), 0
    pool = futures.ThreadPoolExecutor(max_workers=6)  # overlaps JPEG decode/encode with the GPU

    def load(p):
        return read_rgb(p[0], size)

    def save(p, bgr, line):
        write_image(Path(p[1]), line, quality)
        if p[2] is not None:
            write_image(Path(p[2]), watercolor_blend(bgr, line), quality)

    def prefetch(items, ahead=24):
        """Yield (item, image) in order while keeping at most `ahead` decodes in flight."""
        q = []
        it = iter(items)
        for p in it:
            q.append((p, pool.submit(load, p)))
            if len(q) >= ahead:
                break
        while q:
            p, fut = q.pop(0)
            nxt_p = next(it, None)
            if nxt_p is not None:
                q.append((nxt_p, pool.submit(load, nxt_p)))
            yield p, fut.result()

    # consecutive images of the same pixel size are batched together
    i = 0
    pending = []
    buf_p, buf_img = [], []

    def flush():
        nonlocal done
        if not buf_p:
            return
        lines = run_model(net, device, [cv2.cvtColor(fit_side(b, max_side), cv2.COLOR_BGR2RGB) for b in buf_img])
        lines = [l if l.shape == b.shape[:2] else cv2.resize(l, (b.shape[1], b.shape[0]), interpolation=cv2.INTER_CUBIC)
                 for l, b in zip(lines, buf_img)]
        for p, b, l in zip(buf_p, buf_img, lines):
            pending.append(pool.submit(save, p, b, l))
        done += len(buf_p)
        buf_p.clear(); buf_img.clear()

    for p, img in prefetch(todo):
        if buf_img and (img.shape != buf_img[0].shape or len(buf_img) >= batch):
            flush()
        buf_p.append(p); buf_img.append(img)
        i += 1
        if log_every and i % log_every == 0:
            el = time.time() - t0
            print(f"  {i}/{len(todo)} images, {el:.0f}s, {el / i:.3f}s each", flush=True)
    flush()
    for f in pending:
        f.result()
    pool.shutdown()
    return done


def cmd_stylize(a):
    net, device = load_model(a.weights, a.style, a.device)
    src = Path(a.input)
    imgs = list_images(src)
    ext = a.ext
    pairs = []
    for p in imgs:
        rel = p.relative_to(src)
        name = rel.with_suffix(ext) if ext else rel
        pairs.append((p, Path(a.contour) / name, (Path(a.watercolor) / name) if a.watercolor else None))
    print(f"stylize {len(pairs)} images on {device}")
    t = time.time()
    n = stylize_pairs(pairs, net, device, a.size, a.quality, a.batch, skip_existing=not a.overwrite,
                      max_side=a.max_side)
    print(f"wrote {n} in {time.time() - t:.1f}s")


# --------------------------------------------------------------------------
# Spacery panorama faces
# --------------------------------------------------------------------------

def http_json(url: str):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "spacery-linework"}), timeout=60) as r:
        return json.load(r)


def download(url: str, dst: Path, tries: int = 4) -> None:
    if dst.exists() and dst.stat().st_size > 0:
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(dst.suffix + ".part")
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "spacery-linework"}), timeout=60) as r:
                tmp.write_bytes(r.read())
            tmp.rename(dst)
            return
        except Exception as e:  # noqa: BLE001
            if k == tries - 1:
                raise RuntimeError(f"{url}: {e}")
            time.sleep(1.5 * (k + 1))


def face_urls(node: dict) -> List[str]:
    """The six face URLs of a bootstrap node, at 1024 px, in face index order 0..5."""
    faces = node.get("faces")
    if faces:
        return list(faces)[:6]
    tpl = node.get("textureTemplate")
    if tpl:
        out = []
        for i in range(6):
            u = tpl.replace("{uuid}", node["uuid"]).replace("{resolution}", "1024,")
            u = u.replace("{faceI}", str(i)).replace("{face}", str(i))
            out.append(u)
        return out
    return [f"https://static.mused.com/spaceshare/{node['uuid']}_face{i}_1024.jpg" for i in range(6)]


def scene_nodes(scene_id: str, max_nodes: int, include_initial: bool = True):
    """Return (catalog entry, bootstrap, ordered unique nodes to process, total node count)."""
    cat = http_json(CATALOG_URL)
    entry = next((e for e in cat["spaces"] if e.get("sceneId") == scene_id), None)
    if not entry:
        sys.exit(f"scene {scene_id} not in catalog")
    boot = http_json(entry["bootstrapUrl"])
    lists = [boot["space"]["space_data"].get("nodes", [])]
    for sp in boot.get("orderedSpaces") or []:
        lists.append((sp.get("space_data") or {}).get("nodes", []))
    seen, nodes = set(), []
    for lst in lists:
        for n in lst:
            if n.get("uuid") and n["uuid"] not in seen:
                seen.add(n["uuid"]); nodes.append(n)
    total = len(nodes)
    chosen = nodes[:max_nodes]
    if include_initial and total > max_nodes:
        # the scene opens on initialNode; make sure it has line faces even when it sits past the cap
        init = boot["space"]["space_data"].get("initialNode")
        extra = [n for n in nodes[max_nodes:] if n["uuid"] == init]
        chosen += extra
    return entry, boot, chosen, total


def cmd_faces(a):
    entry, _boot, nodes, total = scene_nodes(a.scene, a.max_nodes)
    out = Path(a.out)
    jobs = []
    for n in nodes:
        for i, u in enumerate(face_urls(n)):
            jobs.append((u, out / n["uuid"] / f"{i}.jpg"))
    print(f"{entry['title']}: {len(nodes)} of {total} nodes, {len(jobs)} faces")
    t = time.time()
    with futures.ThreadPoolExecutor(max_workers=a.workers) as ex:
        list(ex.map(lambda j: download(*j), jobs))
    (out / "nodes.json").write_text(json.dumps({"sceneId": a.scene, "total": total,
                                                 "nodes": [n["uuid"] for n in nodes]}, indent=1))
    print(f"downloaded in {time.time() - t:.1f}s")


def cmd_panos(a):
    """Download faces, run contour + watercolor at 1024, write index.json for one scene."""
    entry, _boot, nodes, total = scene_nodes(a.scene, a.max_nodes)
    work = Path(a.work)
    faces_dir = work / "faces"
    out = Path(a.out) / a.scene
    jobs, pairs = [], []
    for n in nodes:
        for i, u in enumerate(face_urls(n)):
            src = faces_dir / n["uuid"] / f"{i}.jpg"
            jobs.append((u, src))
            pairs.append((src, out / "contour" / n["uuid"] / f"{i}.jpg", out / "watercolor" / n["uuid"] / f"{i}.jpg"))
    print(f"{a.scene} {entry['title']}: {len(nodes)} of {total} nodes, {len(jobs)} faces")
    t = time.time()
    with futures.ThreadPoolExecutor(max_workers=a.workers) as ex:
        list(ex.map(lambda j: download(*j), jobs))
    print(f"  faces downloaded in {time.time() - t:.1f}s")
    net, device = load_model(a.weights, "contour", a.device)
    t = time.time()
    n = stylize_pairs(pairs, net, device, 1024, a.quality, a.batch)
    print(f"  stylized {n} faces on {device} in {time.time() - t:.1f}s")
    base = f"{PUBLIC_BASE}/{a.scene}"
    index = {
        "version": 1,
        "sceneId": a.scene,
        "size": 1024,
        "styles": {
            "contour": f"{base}/contour/{{uuid}}/{{face}}.jpg",
            "watercolor": f"{base}/watercolor/{{uuid}}/{{face}}.jpg",
        },
        "nodes": [n["uuid"] for n in nodes],
    }
    (out / "index.json").write_text(json.dumps(index, indent=1))
    print(f"  wrote {out / 'index.json'} ({len(nodes)} nodes, scene has {total})")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    here = Path(__file__).resolve().parent

    s = sub.add_parser("stylize", help="folder of images -> contour (+ watercolor) folders")
    s.add_argument("--input", required=True)
    s.add_argument("--contour", required=True, help="output folder for line drawings")
    s.add_argument("--watercolor", help="output folder for the watercolor blend")
    s.add_argument("--weights", default=os.environ.get("LINEWORK_WEIGHTS", str(here / "weights")))
    s.add_argument("--style", default="contour", choices=["contour", "anime", "opensketch"])
    s.add_argument("--size", type=int, default=0, help="resize to a size x size square first (0 = native)")
    s.add_argument("--max-side", type=int, default=0,
                   help="draw at most this long side, then scale the drawing back to the input size (0 = native)")
    s.add_argument("--ext", default="", help="force output extension, e.g. .jpg (default keeps the input name)")
    s.add_argument("--quality", type=int, default=92)
    s.add_argument("--batch", type=int, default=4)
    s.add_argument("--device")
    s.add_argument("--overwrite", action="store_true")
    s.set_defaults(fn=cmd_stylize)

    f = sub.add_parser("faces", help="download a scene's cube faces")
    f.add_argument("--scene", required=True)
    f.add_argument("--out", required=True)
    f.add_argument("--max-nodes", type=int, default=400)
    f.add_argument("--workers", type=int, default=16)
    f.set_defaults(fn=cmd_faces)

    p = sub.add_parser("panos", help="faces + contour + watercolor + index.json for a scene")
    p.add_argument("--scene", required=True)
    p.add_argument("--work", required=True, help="cache folder for downloaded faces")
    p.add_argument("--out", required=True, help="output root; writes <out>/<sceneId>/{contour,watercolor,index.json}")
    p.add_argument("--weights", default=os.environ.get("LINEWORK_WEIGHTS", str(here / "weights")))
    p.add_argument("--max-nodes", type=int, default=400)
    p.add_argument("--quality", type=int, default=85)
    p.add_argument("--batch", type=int, default=2)
    p.add_argument("--workers", type=int, default=16)
    p.add_argument("--device")
    p.set_defaults(fn=cmd_panos)

    a = ap.parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    main()
