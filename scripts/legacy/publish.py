#!/usr/bin/env python3
"""Publish recovered metadata/previews, preserving existing GCS catalog entries.

References to existing images, meshes, audio and video remain on their asset host.
Only validated runtime bootstraps and JPEG previews are uploaded. Source exports,
SDK key files, inventories, manifests and audit reports stay local.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
from urllib.parse import urlsplit

spec = importlib.util.spec_from_file_location('scene_publish', Path(__file__).resolve().parents[1] / 'matterport/publish.py')
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)


def stage_scene(folder, entry, base, stage):
    if not re.fullmatch(r'[a-f0-9]{12}', entry['sceneId']):
        raise ValueError('Invalid scene ID')
    manifest = json.loads((folder / 'manifest.json').read_text())
    validation = json.loads((folder / 'validation.json').read_text())
    files = {name: common.digest(folder / name) for name in ('bootstrap.json', 'preview.jpg')}
    if manifest['sceneId'] != entry['sceneId'] or not validation.get('passed') or validation.get('files') != files:
        raise ValueError('Unvalidated or modified recovery package: ' + folder.name)
    revision = hashlib.sha256(json.dumps({'version': 1, 'base': base, 'files': files}, sort_keys=True).encode()).hexdigest()[:16]
    relative = f"scenes/{entry['sceneId']}/{revision}"
    destination = f'{base}/{relative}'
    output = stage / relative
    output.mkdir(parents=True, exist_ok=True)
    bootstrap = json.loads((folder / 'bootstrap.json').read_text())
    bootstrap.setdefault('ui', {})['loadingImage'] = destination + '/preview.jpg'
    (output / 'bootstrap.json').write_text(json.dumps(bootstrap, ensure_ascii=False, indent=2) + '\n')
    shutil.copyfile(folder / 'preview.jpg', output / 'preview.jpg')
    return dict(entry, bootstrapUrl=destination + '/bootstrap.json', thumbnail=destination + '/preview.jpg')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--bucket', default='mused')
    parser.add_argument('--prefix', default='sphr')
    parser.add_argument('--origin', default='https://static.mused.com')
    parser.add_argument('--app-origin', default='https://app.mused.com')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--make-source-public', action='store_true', help='Enable only recovered records whose original privacy was PUBLIC')
    args = parser.parse_args()
    for value in (args.origin, args.app_origin):
        url = urlsplit(value)
        if url.scheme != 'https' or not url.netloc or url.path not in ('', '/') or url.username or url.query or url.fragment:
            parser.error('Expected HTTPS origins without paths or credentials')
    if not re.fullmatch(r'[a-z0-9][a-z0-9.-]+', args.bucket) or not re.fullmatch(r'[a-zA-Z0-9_-]+(?:/[a-zA-Z0-9_-]+)*', args.prefix):
        parser.error('Invalid bucket or prefix')
    username, password = os.environ.get('SPHR_PUBLISH_ADMIN_USERNAME'), os.environ.get('SPHR_PUBLISH_ADMIN_PASSWORD')
    if args.make_source_public and not args.dry_run and (not username or not password):
        parser.error('Provide SPHR_PUBLISH_ADMIN_USERNAME and SPHR_PUBLISH_ADMIN_PASSWORD in the environment')
    local = json.loads((args.directory / 'index.json').read_text())['spaces']
    if not local:
        parser.error('No recovered entries')
    base = args.origin.rstrip('/') + '/' + args.prefix
    bucket = f'gs://{args.bucket}/{args.prefix}'
    public_ids = []
    with tempfile.TemporaryDirectory(prefix='sphr-recovery-publish-') as temp:
        stage = Path(temp)
        entries = []
        for entry in common.merge_catalog([], local):
            if not re.fullmatch(r'(space|tour)-[1-9][0-9]*', entry['slug']):
                raise ValueError('Invalid recovery storage slug')
            folder = args.directory / entry['slug']
            entries.append(stage_scene(folder, entry, base, stage))
            if json.loads((folder / 'manifest.json').read_text()).get('privacy') == 'PUBLIC':
                public_ids.append(entry['sceneId'])
        if not args.dry_run:
            common.gcloud('rsync', stage / 'scenes', bucket + '/scenes', '--recursive', '--checksums-only', '--cache-control=public,max-age=31536000,immutable')
            # No delete-unmatched flag: prior immutable revisions remain available.
            catalog = common.commit_catalog(entries, stage / 'index.json', bucket + '/datasets/matterport/index.json')
            if args.make_source_public:
                common.make_public(public_ids, args.app_origin.rstrip('/'), username, password)
        else:
            catalog = {'spaces': entries}
        print(json.dumps({'dryRun': args.dry_run, 'recovered': len(entries), 'catalogEntries': len(catalog['spaces']),
                          'sourcePublic': len(public_ids), 'madePublic': args.make_source_public and not args.dry_run}, indent=2))


if __name__ == '__main__':
    main()
