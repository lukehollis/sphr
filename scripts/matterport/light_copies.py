#!/usr/bin/env python3
"""Make light copies of published captures: smaller panorama faces and a compressed capture model.

The viewer shows a space's smallest faces first and sharpens them, and phones keep to the
mid-size faces, the lighter capture model and a lighter reconstruction (lib/three/light.ts). The published package stays as it
is; the copies sit beside it under <prefix>/<sceneId>/<version>/, listed by
<prefix>/<sceneId>/index.json, which the app finds by scene ID (lib/server/light.ts).

    python3 scripts/matterport/light_copies.py 619ad80511a1 5b073eb82f3f --stage /tmp/light
    python3 scripts/matterport/light_copies.py 619ad80511a1 --stage /tmp/light --upload \
        --model-copy https://.../giza.glb=../reconstructions/out/giza/mobile/giza_mobile.glb

A model with a prepared phone copy (--model-copy, such as a reconstruction's mobile.py build: fewer
triangles away from the captures, sculptures baked to normal maps) uses it; others are re-encoded here.

Needs Pillow, Node (for npx @gltf-transform/cli) and, to upload, an authenticated gcloud CLI.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import time
import urllib.parse
import urllib.request

from PIL import Image

CATALOG = 'https://static.mused.com/sphr/datasets/matterport/index.json'
RECONSTRUCTIONS = 'https://storage.googleapis.com/spacery-static/sphr/reconstructions'
SIZES = (512, 1024)
QUALITY = {512: 78, 1024: 82}
# Capture meshes are one textured surface; reconstructions carry many textures and much more geometry.
CAPTURE_TEXTURE = 2048
RECONSTRUCTION_TEXTURE = 1024
GLTF = ['npx', '--yes', '@gltf-transform/cli@4.0.10']


def fetch(url, attempts=6):
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'spacery-light-copies'}), timeout=60) as response:
                return response.read()
        except Exception:
            if attempt == attempts - 1:
                raise
            time.sleep(2 ** attempt)  # dropped connections and failed lookups pass


def scene_bootstrap(scene_id, catalog):
    entry = next((item for item in catalog['spaces'] if item.get('sceneId') == scene_id), None)
    if not entry:
        raise SystemExit(f'{scene_id} is not in the catalog')
    return json.loads(fetch(entry['bootstrapUrl']))


def face_nodes(bootstrap):
    """Nodes with six explicit cube faces; others (one photo, templated faces) are left alone."""
    nodes = bootstrap['space']['space_data'].get('nodes') or bootstrap['space']['space_data'].get('navPoints') or []
    return [node for node in nodes if len(node.get('faces') or node.get('cubeFaces') or []) == 6]


def capture_models(bootstrap):
    """The capture's raycast models, as the scene graph names them (published GLBs only)."""
    graphs = [bootstrap.get('tour', {}).get('tour_data', {}).get('sceneGraph') or [], bootstrap['space']['space_data'].get('sceneGraph') or []]
    found = []
    def walk(nodes):
        for node in nodes:
            if node.get('type') == 'model' and node.get('raycast') and re.match(r'^https://.+\.glb$', node.get('file') or ''):
                found.append(node['file'])
            walk(node.get('children') or [])
    for graph in graphs:
        walk(graph)
    return list(dict.fromkeys(found))


def reconstruction_models(bootstrap, scene_id, base):
    """The reconstruction a scene shows: named in its package, or kept beside it by scene ID."""
    urls = []
    source = bootstrap['space']['space_data'].get('reconstruction')
    if isinstance(source, str):
        urls.append(source)
    if base:
        urls.append(f'{base}/{scene_id}/index.json')
    models = []
    for url in urls:
        try:
            manifest = json.loads(fetch(url, attempts=1))
        except Exception:
            continue
        model = manifest.get('model') if isinstance(manifest, dict) else None
        if isinstance(model, str):
            models.append(urllib.parse.urljoin(url, model))
    return list(dict.fromkeys(models))


def write_faces(node, folder):
    for face, url in enumerate(node.get('faces') or node.get('cubeFaces')):
        image = Image.open(io.BytesIO(fetch(url))).convert('RGB')
        for size in SIZES:
            if size >= image.width:
                continue
            target = folder / 'faces' / str(size) / node['uuid'] / f'face{face}.jpg'
            target.parent.mkdir(parents=True, exist_ok=True)
            image.resize((size, size), Image.LANCZOS).save(target, 'JPEG', quality=QUALITY[size], optimize=True, progressive=True)


def write_model(url, folder, texture, prepared=None):
    # Named after the published address too, so a rebuilt model never takes an old copy's place in caches.
    name = hashlib.sha256(url.encode()).hexdigest()[:12] + '-' + re.sub(r'[^A-Za-z0-9._-]', '-', url.rsplit('/', 1)[-1])
    if prepared:
        data = Path(prepared).read_bytes()
        target = folder / 'models' / (name[:-4] + '-' + hashlib.sha256(data).hexdigest()[:8] + '.glb')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return target
    work = folder / 'work'
    work.mkdir(parents=True, exist_ok=True)
    source = work / 'source.glb'
    source.write_bytes(fetch(url))
    # Textures only ever shrink, then become WebP; node extras (a reconstruction's periods) and materials are kept.
    # (KTX2 would save graphics memory but drew dark in the iOS simulator; see reconstructions/mobile_pack.sh.)
    steps = [('weld', []), ('resize', ['--width', str(texture), '--height', str(texture)]),
             ('webp', ['--slots', 'baseColorTexture', '--quality', '82']), ('draco', [])]
    current = source
    for index, (command, options) in enumerate(steps):
        output = work / f'{index}-{command}.glb'
        subprocess.run(GLTF + [command, str(current), str(output), *options], check=True, capture_output=True)
        current = output
    data = current.read_bytes()
    # And after what it holds, since copies are cached for good: a new build gets a new address.
    target = folder / 'models' / (name[:-4] + '-' + hashlib.sha256(data).hexdigest()[:8] + '.glb')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    for path in work.iterdir():
        path.unlink()
    work.rmdir()
    return target


def make(scene_id, catalog, stage, origin, reconstructions, prepared):
    bootstrap = scene_bootstrap(scene_id, catalog)
    nodes = face_nodes(bootstrap)
    captures = capture_models(bootstrap)
    rebuilt = [url for url in reconstruction_models(bootstrap, scene_id, reconstructions) if url not in captures]
    models = captures + rebuilt
    # The copies' folder is named after the capture they copy, so a new capture gets a new address.
    version = hashlib.sha256(json.dumps([[n['uuid'], n.get('faces') or n.get('cubeFaces')] for n in nodes] + captures).encode()).hexdigest()[:16]
    folder = stage / scene_id / version
    base = f'{origin}/{scene_id}/{version}'
    with ThreadPoolExecutor(16) as pool:
        list(pool.map(lambda node: write_faces(node, folder), nodes))
    sizes = sorted({int(path.name) for path in (folder / 'faces').iterdir()}) if (folder / 'faces').exists() else []
    index = {'version': 1}
    if nodes and sizes:
        index['faces'] = {'template': f'{base}/faces/{{size}}/{{uuid}}/face{{face}}.jpg', 'sizes': sizes, 'nodes': [node['uuid'] for node in nodes]}
    lighter = {}
    for url in models:
        target = write_model(url, folder, CAPTURE_TEXTURE if url in captures else RECONSTRUCTION_TEXTURE, prepared.get(url))
        lighter[url] = f'{base}/models/{target.name}'
        print(f'  model {url.rsplit("/", 1)[-1]}: {len(fetch(url)) / 1e6:.1f} MB -> {target.stat().st_size / 1e6:.1f} MB')
    if lighter:
        index['models'] = lighter
    if len(index) == 1:
        # One photo per location, splats or a model alone: nothing here has a smaller copy.
        print(f'{scene_id}: nothing to copy')
        return None
    (stage / scene_id / 'index.json').write_text(json.dumps(index, indent=1))
    print(f'{scene_id}: {len(nodes)} locations, sizes {sizes}, {len(lighter)} models, in {folder}')
    return version


def run(command, attempts=4):
    for attempt in range(attempts):
        if subprocess.run(command).returncode == 0:
            return
        time.sleep(5 * 2 ** attempt)
    raise RuntimeError('failed: ' + ' '.join(command[:4]))


def upload(scene_id, version, stage, bucket_root):
    folder = stage / scene_id / version
    run(['gcloud', 'storage', 'rsync', str(folder), f'{bucket_root}/{scene_id}/{version}', '--recursive',
         '--cache-control=public,max-age=31536000,immutable'])
    # The index goes last and stays fresh, so it never lists copies that are not there yet.
    run(['gcloud', 'storage', 'cp', str(stage / scene_id / 'index.json'), f'{bucket_root}/{scene_id}/index.json',
         '--cache-control=public,max-age=300', '--content-type=application/json'])


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('scenes', nargs='+', help='scene IDs from the catalog')
    parser.add_argument('--stage', type=Path, required=True)
    parser.add_argument('--catalog', default=CATALOG)
    parser.add_argument('--origin', default='https://static.mused.com/sphr/light', help='where the bucket folder is served')
    parser.add_argument('--bucket-root', default='gs://mused/sphr/light')
    parser.add_argument('--reconstructions', default=RECONSTRUCTIONS, help='folder of <sceneId>/index.json reconstruction manifests, or empty')
    parser.add_argument('--upload', action='store_true')
    parser.add_argument('--model-copy', action='append', default=[], metavar='URL=PATH', help='a prepared phone copy of a published model')
    args = parser.parse_args()
    if not all(re.fullmatch(r'[a-f0-9]{12}', scene) for scene in args.scenes):
        parser.error('Scene IDs are 12 hex characters')
    catalog = json.loads(fetch(args.catalog))
    prepared = dict(item.split('=', 1) for item in args.model_copy)
    for scene in args.scenes:
        version = make(scene, catalog, args.stage, args.origin.rstrip('/'), args.reconstructions.rstrip('/'), prepared)
        if args.upload and version:
            upload(scene, version, args.stage, args.bucket_root.rstrip('/'))


if __name__ == '__main__':
    main()
