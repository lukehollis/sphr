#!/usr/bin/env python3
"""Sky outlines for a space's 360 photos, so a tour can put another sky behind them.

Each cube face goes through UperNet (ConvNeXt small, trained on ADE20K, MIT licensed,
openmmlab/upernet-convnext-small) and keeps its "sky" class, snapped to the photo's own
edges with a guided filter. Faces that are part sky get a 512 px grayscale mask (white is
sky); faces that are all sky or have none are only noted in the manifest. The result is
merged into the space's drawn-versions manifest (scripts/lines), which the viewer already
reads from SPHR_LINES_BASE_URL/<sceneId>/index.json:

    "sky": {"template": ".../<sceneId>/sky/{uuid}/{face}.jpg", "nodes": {"<uuid>": "221100"}}

with one digit per face: 0 no sky, 1 part sky (a mask file), 2 all sky.

    python3 scripts/skies/masks.py scan                       # which catalog spaces are outdoors
    python3 scripts/skies/masks.py scene --scene <id> --work <cache> --out <dir>
    python3 scripts/skies/masks.py scene --bootstrap <url> --scene <id> ...   # a space outside the catalog
    scripts/skies/upload.sh masks <dir>/<id> <id>

Requires torch, transformers, opencv-python and numpy; runs on CUDA, Apple MPS or CPU.
"""
from __future__ import annotations

import argparse
import concurrent.futures as futures
import json
import sys
import time
import urllib.request
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lines"))
from linework import CATALOG_URL, PUBLIC_BASE, download, face_urls, http_json, scene_nodes  # noqa: E402

MODEL = "openmmlab/upernet-convnext-small"
INPUT = 576  # divisible by every pooling stage
MASK = 512
FACES = range(5)  # the sixth face looks straight down


class SkyModel:
    def __init__(self, device: str | None = None):
        import torch
        from transformers import AutoImageProcessor, UperNetForSemanticSegmentation
        self.torch = torch
        self.device = device or ("cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu")
        self.processor = AutoImageProcessor.from_pretrained(MODEL)
        self.model = UperNetForSemanticSegmentation.from_pretrained(MODEL).to(self.device).eval()
        self.sky = next(int(i) for i, name in self.model.config.id2label.items() if name.lower() == "sky")

    def __call__(self, images: list[np.ndarray]) -> list[np.ndarray]:
        """Sky probability (0..1) at INPUT size for RGB images."""
        torch = self.torch
        batch = [cv2.resize(image, (INPUT, INPUT), interpolation=cv2.INTER_AREA) for image in images]
        inputs = self.processor(images=batch, do_resize=False, return_tensors="pt").to(self.device)
        with torch.no_grad():
            logits = self.model(**inputs).logits
            logits = torch.nn.functional.interpolate(logits, size=(INPUT, INPUT), mode="bilinear", align_corners=False)
            probability = logits.softmax(1)[:, self.sky].float().cpu().numpy()
        return list(probability)


def guided(guide: np.ndarray, source: np.ndarray, radius: int = 6, eps: float = 2e-3) -> np.ndarray:
    """He et al.'s guided filter: the mask follows the photo's edges."""
    box = lambda image: cv2.blur(image, (2 * radius + 1, 2 * radius + 1))  # noqa: E731
    mean_i, mean_p = box(guide), box(source)
    var_i = box(guide * guide) - mean_i * mean_i
    cov = box(guide * source) - mean_i * mean_p
    a = cov / (var_i + eps)
    b = mean_p - a * mean_i
    return box(a) * guide + box(b)


def refine(rgb: np.ndarray, probability: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(cv2.resize(rgb, (MASK, MASK), interpolation=cv2.INTER_AREA), cv2.COLOR_RGB2GRAY).astype(np.float32) / 255
    mask = cv2.resize(probability.astype(np.float32), (MASK, MASK), interpolation=cv2.INTER_LINEAR)
    mask = guided(gray, mask)
    t = np.clip((mask - 0.3) / 0.4, 0, 1)
    return t * t * (3 - 2 * t)


def read_rgb(path: Path) -> np.ndarray:
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"unreadable face {path}")
    return cv2.cvtColor(image, cv2.COLOR_BGR2RGB)


def nodes_for(a):
    if a.bootstrap:
        boot = http_json(a.bootstrap)
        lists = [boot["space"]["space_data"].get("nodes", [])] + [(space.get("space_data") or {}).get("nodes", []) for space in boot.get("orderedSpaces") or []]
        seen, nodes = set(), []
        for node in (node for nodes in lists for node in nodes):
            if node.get("uuid") and node["uuid"] not in seen:
                seen.add(node["uuid"])
                nodes.append(node)
        return boot["space"].get("title", a.scene), nodes
    entry, _boot, nodes, _total = scene_nodes(a.scene, a.max_nodes)
    return entry["title"], nodes


def cube_nodes(nodes):
    """Nodes drawn from cube faces; single equirectangular images have no faces to outline."""
    return [node for node in nodes if node.get("faces") or node.get("cubeFaces") or node.get("textureTemplate") or not node.get("image")]


def cmd_scene(a):
    title, nodes = nodes_for(a)
    nodes = cube_nodes(nodes)
    work, out = Path(a.work) / "faces", Path(a.out) / a.scene
    done = Path(a.work) / "sky"
    jobs = [(url, work / node["uuid"] / f"{face}.jpg") for node in nodes if not (done / node["uuid"] / "codes.txt").exists()
            for face, url in enumerate(face_urls(node)) if face in FACES]
    print(f"{a.scene} {title}: {len(nodes)} locations, {len(jobs)} faces")
    started = time.time()
    with futures.ThreadPoolExecutor(max_workers=a.workers) as pool:
        list(pool.map(lambda job: download(*job), jobs))
    print(f"  downloaded in {time.time() - started:.0f} s")
    # Outlines are kept per location in the work folder, so spaces that share a capture reuse them.
    cache = Path(a.work) / "sky"
    codes: dict[str, str] = {}
    pending = []
    for node in nodes:
        known = cache / node["uuid"] / "codes.txt"
        if known.exists():
            codes[node["uuid"]] = known.read_text().strip()
        else:
            pending += [(node["uuid"], face) for face in FACES]
    model = SkyModel(a.device) if pending else None
    started = time.time()
    fresh: dict[str, str] = {}
    for start in range(0, len(pending), a.batch):
        chunk = pending[start: start + a.batch]
        images = [read_rgb(work / uuid / f"{face}.jpg") for uuid, face in chunk]
        for (uuid, face), rgb, probability in zip(chunk, images, model(images)):
            mask = refine(rgb, probability)
            share = float(mask.mean())
            code = "0" if share < 0.004 else "2" if share > 0.996 else "1"
            if code == "1":
                path = cache / uuid / f"{face}.jpg"
                path.parent.mkdir(parents=True, exist_ok=True)
                cv2.imwrite(str(path), (mask * 255 + 0.5).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 90])
            current = fresh.get(uuid, "000000")
            fresh[uuid] = current[:face] + code + current[face + 1:]
            if face == FACES[-1]:
                (cache / uuid).mkdir(parents=True, exist_ok=True)
                (cache / uuid / "codes.txt").write_text(fresh[uuid])
        if start // a.batch % 100 == 0:
            print(f"  {start + len(chunk)} of {len(pending)} faces, {time.time() - started:.0f} s", flush=True)
    codes.update(fresh)
    print(f"  outlined {len(pending)} faces in {time.time() - started:.0f} s ({len(nodes) - len(pending) // len(FACES)} locations already done)")
    # Copy this space's outlines next to its manifest.
    for uuid, code in codes.items():
        for face, digit in enumerate(code):
            if digit != "1":
                continue
            source, destination = cache / uuid / f"{face}.jpg", out / "sky" / uuid / f"{face}.jpg"
            destination.parent.mkdir(parents=True, exist_ok=True)
            if not destination.exists():
                destination.write_bytes(source.read_bytes())
    with_sky = {uuid: code for uuid, code in codes.items() if code != "000000"}
    # Merge into the drawn-versions manifest, keeping any line drawings already listed.
    manifest_path = out / "index.json"
    try:
        manifest = http_json(f"{PUBLIC_BASE}/{a.scene}/index.json")
    except Exception:  # noqa: BLE001 - no drawings yet
        manifest = {"version": 1, "sceneId": a.scene, "size": 1024, "styles": {}, "nodes": []}
    manifest["sky"] = {"template": f"{PUBLIC_BASE}/{a.scene}/sky/{{uuid}}/{{face}}.jpg", "size": MASK, "nodes": with_sky}
    out.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=1))
    print(f"  {len(with_sky)} of {len(nodes)} locations see sky; wrote {manifest_path}")


def cmd_scan(a):
    """Which catalog spaces have panoramas that see the sky, from a few of each one's upward faces."""
    model = SkyModel(a.device)
    catalog = http_json(CATALOG_URL)
    work = Path(a.work) / "faces"
    rows = []
    for entry in catalog["spaces"]:
        scene = entry.get("sceneId")
        try:
            boot = http_json(entry["bootstrapUrl"])
        except Exception as error:  # noqa: BLE001
            print(f"{scene} skipped: {error}", file=sys.stderr)
            continue
        nodes = cube_nodes(boot["space"]["space_data"].get("nodes", []))
        if not nodes:
            continue
        sample = nodes[:: max(1, len(nodes) // a.sample)][: a.sample]
        jobs = [(face_urls(node)[0], work / node["uuid"] / "0.jpg") for node in sample]
        try:
            with futures.ThreadPoolExecutor(max_workers=8) as pool:
                list(pool.map(lambda job: download(*job), jobs))
        except Exception as error:  # noqa: BLE001
            print(f"{scene} faces unavailable: {error}", file=sys.stderr)
            continue
        shares = [float(refine(rgb, p).mean()) for rgb, p in zip(*(lambda images: (images, model(images)))([read_rgb(path) for _, path in jobs]))]
        outdoor = sum(share > 0.15 for share in shares) / len(shares)
        rows.append({"sceneId": scene, "title": entry.get("title"), "nodes": len(nodes), "outdoor": round(outdoor, 2)})
        print(f"{scene} {outdoor:4.2f} {len(nodes):4d} {entry.get('title')}", flush=True)
    Path(a.work, "scan.json").write_text(json.dumps(rows, indent=1))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    scan = sub.add_parser("scan", help="find the catalog spaces whose photos see the sky")
    scan.add_argument("--work", required=True)
    scan.add_argument("--sample", type=int, default=10)
    scan.add_argument("--device")
    scan.set_defaults(fn=cmd_scan)
    scene = sub.add_parser("scene", help="outline the sky in every photo of one space")
    scene.add_argument("--scene", required=True)
    scene.add_argument("--bootstrap", help="bootstrap JSON address, for a space outside the catalog")
    scene.add_argument("--work", required=True, help="cache folder for downloaded faces")
    scene.add_argument("--out", required=True, help="writes <out>/<sceneId>/{sky/,index.json}")
    scene.add_argument("--max-nodes", type=int, default=5000)
    scene.add_argument("--batch", type=int, default=4)
    scene.add_argument("--workers", type=int, default=16)
    scene.add_argument("--device")
    scene.set_defaults(fn=cmd_scene)
    args = parser.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
