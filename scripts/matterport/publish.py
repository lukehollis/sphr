#!/usr/bin/env python3
"""Publish verified runtime packages to GCS, then atomically merge the catalog.

No source exports, import receipts, staging folders, or credentials are uploaded.
Requires an authenticated gcloud CLI. A failed upload leaves the live catalog alone.
"""
import argparse
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
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


def commit_catalog(published, index, uri):
    """Merge after asset upload; retry only when another publisher won the CAS."""
    remote, generation = read_remote_catalog(uri)
    for attempt in range(5):
        catalog = {'schema': 'sphr-matterport-index-v2', 'spaces': merge_catalog(remote, published)}
        index.write_text(json.dumps(catalog, indent=2) + '\n')
        try:
            gcloud('cp', index, uri, '--content-type=application/json',
                   '--cache-control=no-store', '--if-generation-match=' + generation)
            return catalog
        except subprocess.CalledProcessError:
            latest, current_generation = read_remote_catalog(uri)
            if current_generation == generation or attempt == 4:
                raise
            print('Catalog changed during publication; merging the latest scenes and retrying.', flush=True)
            remote, generation = latest, current_generation


class NoAdminRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        # Credentials and the session are intended for exactly --app-origin.
        return None


def make_public(scene_ids, app_origin, username, password):
    """Enable selected uploaded scenes, using a short-lived in-memory session."""
    if not scene_ids or any(not re.fullmatch(r'[a-f0-9]{12}', value) for value in scene_ids):
        raise ValueError('Public visibility requires valid selected scene IDs')
    opener = urllib.request.build_opener(
        NoAdminRedirect(), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def send(path, body, method='POST'):
        request = urllib.request.Request(app_origin + path, data=json.dumps(body).encode(),
            headers={'Content-Type': 'application/json', 'Origin': app_origin}, method=method)
        try:
            with opener.open(request, timeout=45) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f'Admin request {path} failed (HTTP {error.code})') from None
        if result.get('ok') is not True:
            raise RuntimeError(f'Admin request {path} did not confirm success')
        return result

    send('/api/admin/login', {'username': username, 'password': password})
    try:
        for scene_id in scene_ids:
            result = send('/api/admin/scenes/' + scene_id, {'public': True}, 'PATCH')
            if result.get('public') is not True:
                raise RuntimeError(f'Public visibility was not confirmed for {scene_id}')
            print(f'Public viewer enabled: {app_origin}/s/{scene_id}', flush=True)
    finally:
        try:
            send('/api/admin/logout', {})
        except Exception:
            # Preserve any original publication failure and never print secrets.
            print('Admin logout failed; the temporary session will expire.', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bucket', default='mused')
    parser.add_argument('--prefix', default='sphr')
    parser.add_argument('--origin', default='https://static.mused.com')
    parser.add_argument('--app-origin', default='https://app.mused.com', help='HTTPS viewer/admin origin')
    parser.add_argument('--directory', type=Path, default=ROOT/'public/datasets/matterport')
    parser.add_argument('--slug', action='append', help='Publish selected storage slugs; preserve all other remote scenes')
    parser.add_argument('--include-demo', action='store_true')
    parser.add_argument('--dry-run', action='store_true', help='Validate and plan locally without cloud reads or writes')
    parser.add_argument('--make-public', action='store_true',
                        help='After upload and catalog publication, enable selected --slug viewers using SPHR_PUBLISH_ADMIN_USERNAME and SPHR_PUBLISH_ADMIN_PASSWORD')
    args = parser.parse_args()
    origin = urlsplit(args.origin)
    if origin.scheme != 'https' or not origin.netloc or origin.path not in ('', '/') or origin.query or origin.fragment or origin.username:
        parser.error('--origin must be an HTTPS origin without a path or credentials')
    app_origin = urlsplit(args.app_origin)
    if app_origin.scheme != 'https' or not app_origin.netloc or app_origin.path not in ('', '/') or app_origin.query or app_origin.fragment or app_origin.username:
        parser.error('--app-origin must be an HTTPS origin without a path or credentials')
    args.app_origin = args.app_origin.rstrip('/')
    username = os.environ.get('SPHR_PUBLISH_ADMIN_USERNAME')
    password = os.environ.get('SPHR_PUBLISH_ADMIN_PASSWORD')
    if args.make_public and not args.slug:
        parser.error('--make-public requires explicit --slug selections')
    if args.make_public and not args.dry_run and (not username or not password):
        parser.error('--make-public requires SPHR_PUBLISH_ADMIN_USERNAME and SPHR_PUBLISH_ADMIN_PASSWORD in the environment')
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
        catalog = {'schema':'sphr-matterport-index-v2', 'spaces':merge_catalog([], published)}
        index = stage/'index.json'
        index.write_text(json.dumps(catalog, indent=2) + '\n')
        if not args.dry_run:
            for relative in paths:
                cache = 'public,max-age=3600' if relative == 'demo' else 'public,max-age=31536000,immutable'
                gcloud('rsync', stage/relative, bucket_root+'/'+relative, '--recursive', '--checksums-only', '--cache-control='+cache)
            # Take a fresh remote snapshot after the potentially long upload.
            # The generation guard remains mandatory on every attempted switch.
            catalog = commit_catalog(published, index, catalog_uri)
            if args.make_public:
                try:
                    make_public([entry['sceneId'] for entry in published], args.app_origin, username, password)
                except Exception as error:
                    raise RuntimeError('Assets and catalog are published, but the Public switch failed. '
                                       'Correct the admin credentials or availability and rerun the same command. '
                                       f'{error}') from None
        print(json.dumps({'dryRun':args.dry_run, 'published':len(published), 'catalogScenes':len(catalog['spaces']),
                          'websiteVisibility':'public' if args.make_public and not args.dry_run else 'unchanged',
                          'makePublic':args.make_public,
                          'catalogUrl':base_url+'/datasets/matterport/index.json',
                          'links':[args.app_origin+entry['scenePath'] for entry in published]}, indent=2))


if __name__ == '__main__':
    main()
