"""Publish validated authored tours using already-hosted native assets.

Each scene folder is named by its stable ID and contains bootstrap.json,
preview.jpg, manifest.json and a hash-bound validation.json. Source archives and
binding receipts stay local. The shared publisher preserves concurrent catalog
changes and all unrelated scene identities. Visibility remains a separate admin action.
"""
import argparse
import json
from pathlib import Path
import re
import tempfile
from urllib.parse import urlsplit
from publish import common, stage_scene


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--bucket', required=True)
    parser.add_argument('--prefix', default='sphr')
    parser.add_argument('--origin', required=True)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    origin = urlsplit(args.origin)
    if origin.scheme != 'https' or not origin.netloc or origin.path not in ('', '/') or origin.username or origin.query or origin.fragment:
        parser.error('Expected an HTTPS asset origin without a path or credentials')
    if not re.fullmatch(r'[a-z0-9][a-z0-9.-]+', args.bucket) or not re.fullmatch(r'[a-zA-Z0-9_-]+(?:/[a-zA-Z0-9_-]+)*', args.prefix):
        parser.error('Invalid bucket or prefix')
    entries = common.merge_catalog([], json.loads((args.directory / 'index.json').read_text())['spaces'])
    if not entries:
        parser.error('No tours to publish')
    base = args.origin.rstrip('/') + '/' + args.prefix
    bucket = f'gs://{args.bucket}/{args.prefix}'
    with tempfile.TemporaryDirectory(prefix='sphr-tour-publish-') as temporary:
        stage = Path(temporary)
        published = []
        for entry in entries:
            folder = args.directory / entry['sceneId']
            bootstrap = json.loads((folder / 'bootstrap.json').read_text())
            tour = bootstrap.get('tour', {}).get('tour_data', {})
            if entry.get('hasGuidedTour') is not True or tour.get('mode') != 'guided' or not any(s.get('tourpoints') for s in tour.get('spaces', [])):
                raise ValueError('Expected a nonempty authored guided tour')
            if any(s.get('type') == 'matterport' for s in bootstrap.get('orderedSpaces', [bootstrap['space']])):
                raise ValueError('Native tour publication cannot retain a Matterport renderer')
            published.append(stage_scene(folder, entry, base, stage))
        if not args.dry_run:
            common.gcloud('rsync', stage / 'scenes', bucket + '/scenes', '--recursive', '--checksums-only', '--cache-control=public,max-age=31536000,immutable')
            catalog = common.commit_catalog(published, stage / 'index.json', bucket + '/datasets/matterport/index.json')
        else:
            catalog = {'spaces': published}
        print(json.dumps({'dryRun': args.dry_run, 'tours': len(published), 'catalogEntries': len(catalog['spaces']),
                          'scenes': published}, indent=2))


if __name__ == '__main__':
    main()
