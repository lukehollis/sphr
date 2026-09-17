#!/usr/bin/env python3
"""Publish verified runtime packages to GCS, then atomically merge the catalog.

No source exports, import receipts, staging folders, or credentials are uploaded.
Requires an authenticated gcloud CLI. A failed upload leaves the live catalog alone.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def rewrite(value, source, destination):
    if isinstance(value, str):
        return destination + value[len(source):] if value.startswith(source + '/') else value
    if isinstance(value, list):
        return [rewrite(item, source, destination) for item in value]
    if isinstance(value, dict):
        return {key: rewrite(item, source, destination) for key, item in value.items()}
    return value


def merge_catalog(remote, local):
    by_id = {}
    for batch in (remote, local):
        seen = set()
        for entry in batch:
            scene_id = entry['sceneId']
            if not re.fullmatch(r'[a-f0-9]{12}', scene_id) or scene_id in seen:
                raise ValueError(f'Invalid or duplicate scene ID: {scene_id}')
            seen.add(scene_id)
            by_id[scene_id] = entry
    return sorted(by_id.values(), key=lambda entry: (entry.get('createdAt', ''), entry['sceneId']), reverse=True)


def stage_scene(folder, entry, base_url, stage):
    if not re.fullmatch(r'[a-f0-9]{12}', entry['sceneId']):
        raise ValueError('Invalid scene ID')
    manifest = json.loads((folder / 'manifest.json').read_text())
    validation = json.loads((folder / 'validation.json').read_text())
    if not validation.get('passed') or manifest['sceneId'] != entry['sceneId']:
        raise ValueError(f'Unvalidated package or mismatched ID: {folder.name}')
    # Publish only the current manifest's runtime assets. Reimports may leave
    # older scan directories or mesh names in staging; those are not this scene.
    names = {'bootstrap.json', 'preview.jpg', f"mesh/{manifest['slug']}-50k.glb"}
    for node, group in manifest['imageManifest']['groups'].items():
        names.update(f"faces/{node}/face{face['sphrFace']}.jpg" for face in group['sourceFaces'])
    if (folder / 'mesh/atlas.jpg').is_file():
        names.add('mesh/atlas.jpg')
    files = sorted(folder / name for name in names)
    files = [path for path in files if path.is_file()]
    hashes = {}
    for path in files:
        if path.is_symlink() or folder.resolve() not in path.resolve().parents:
            raise ValueError(f'Asset escapes package: {path}')
        hashes[path.relative_to(folder).as_posix()] = digest(path)
    for node, group in manifest['imageManifest']['groups'].items():
        for face in group['sourceFaces']:
            name = f"faces/{node}/face{face['sphrFace']}.jpg"
            if hashes.get(name) != face['sha256']:
                raise ValueError(f'Image no longer matches validated import: {folder.name}/{name}')
    mesh = f"mesh/{manifest['slug']}-50k.glb"
    if hashes.get(mesh) != manifest['mesh']['sha256']:
        raise ValueError(f'Mesh no longer matches validated import: {folder.name}')
    for required in ('bootstrap.json', 'preview.jpg'):
        if required not in hashes:
            raise ValueError(f'Missing runtime asset: {folder.name}/{required}')
    revision = hashlib.sha256(json.dumps({'version':1, 'base':base_url, 'files':hashes}, sort_keys=True).encode()).hexdigest()[:16]
    relative = f"scenes/{entry['sceneId']}/{revision}"
    target = stage / relative
    target.mkdir(parents=True)
    source_url = manifest['datasetUrl']
    destination = f'{base_url}/{relative}'
    for path in files:
        output = target / path.relative_to(folder)
        output.parent.mkdir(parents=True, exist_ok=True)
        if path.name == 'bootstrap.json':
            bootstrap = rewrite(json.loads(path.read_text()), source_url, destination)
            output.write_text(json.dumps(bootstrap, indent=2) + '\n')
        else:
            shutil.copyfile(path, output)
    result = dict(entry, bootstrapUrl=f'{destination}/bootstrap.json', thumbnail=f'{destination}/preview.jpg')
    return result, relative


def gcloud(*args, capture=False):
    return subprocess.run(['gcloud', 'storage', *map(str, args)], check=True,
                          text=True, stdout=subprocess.PIPE if capture else None).stdout


def read_remote_catalog(uri):
    result = subprocess.run(['gcloud','storage','objects','describe',uri,'--format=json'],
                            text=True, capture_output=True)
    if result.returncode:
        if 'not found: 404' in result.stderr:
            return [], '0'
        raise RuntimeError(result.stderr)
    metadata = json.loads(result.stdout)
    generation = str(metadata['generation'])
    catalog = json.loads(gcloud('cat', f'{uri}#{generation}', capture=True))
    return catalog['spaces'], generation


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bucket', default='mused')
    parser.add_argument('--prefix', default='sphr')
    parser.add_argument('--origin', default='https://static.mused.com')
    parser.add_argument('--directory', type=Path, default=ROOT/'public/datasets/matterport')
    parser.add_argument('--slug', action='append', help='Publish selected storage slugs; preserve all other remote scenes')
    parser.add_argument('--include-demo', action='store_true')
    parser.add_argument('--dry-run', action='store_true', help='Validate and plan locally without cloud reads or writes')
    args = parser.parse_args()
    origin = urlsplit(args.origin)
    if origin.scheme != 'https' or not origin.netloc or origin.path not in ('', '/') or origin.query or origin.fragment or origin.username:
        parser.error('--origin must be an HTTPS origin without a path or credentials')
    if not re.fullmatch(r'[a-z0-9][a-z0-9.-]+', args.bucket) or not re.fullmatch(r'[a-zA-Z0-9_-]+(?:/[a-zA-Z0-9_-]+)*', args.prefix):
        parser.error('Invalid bucket or prefix')
    base_url = args.origin.rstrip('/') + '/' + args.prefix
    bucket_root = f'gs://{args.bucket}/{args.prefix}'
    catalog_uri = bucket_root + '/datasets/matterport/index.json'
    local = json.loads((args.directory/'index.json').read_text())['spaces']
    if args.slug:
        missing = set(args.slug) - {entry['slug'] for entry in local}
        if missing: parser.error('Unknown scene slugs: ' + ', '.join(sorted(missing)))
        local = [entry for entry in local if entry['slug'] in args.slug]
    if not local: parser.error('No scenes to publish')
    remote, generation = ([], '0') if args.dry_run else read_remote_catalog(catalog_uri)
    with tempfile.TemporaryDirectory(prefix='sphr-publish-') as temp:
        stage = Path(temp)
        published, paths = [], []
        for entry in local:
            if not re.fullmatch(r'[a-z0-9-]+', entry['slug']): raise ValueError('Invalid storage slug')
            updated, relative = stage_scene(args.directory/entry['slug'], entry, base_url, stage)
            published.append(updated)
            paths.append(relative)
            print(f"Prepared {entry['title']}: {updated['bootstrapUrl']}", flush=True)
        if args.include_demo:
            demo = ROOT/'public/demo'
            if not (demo/'garden_demo.spark.splat').is_file(): raise ValueError('Missing real Garden splat')
            shutil.copytree(demo, stage/'demo')
            paths.append('demo')
        catalog = {'schema':'sphr-matterport-index-v2', 'spaces':merge_catalog(remote, published)}
        index = stage/'index.json'
        index.write_text(json.dumps(catalog, indent=2) + '\n')
        if not args.dry_run:
            for relative in paths:
                cache = 'public,max-age=3600' if relative == 'demo' else 'public,max-age=31536000,immutable'
                gcloud('rsync', stage/relative, bucket_root+'/'+relative, '--recursive', '--checksums-only', '--cache-control='+cache)
            # One atomic pointer switch, guarded against concurrent publishers.
            gcloud('cp', index, catalog_uri, '--content-type=application/json',
                   '--cache-control=no-store', '--if-generation-match='+generation)
        print(json.dumps({'dryRun':args.dry_run, 'published':len(published), 'catalogScenes':len(catalog['spaces']),
                          'catalogUrl':base_url+'/datasets/matterport/index.json',
                          'links':['https://app.mused.com'+entry['scenePath'] for entry in published]}, indent=2))


if __name__ == '__main__':
    main()
