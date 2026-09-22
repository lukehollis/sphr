#!/usr/bin/env python3
"""Recover an exported SPHR/Django collection without copying panorama originals.

Input is the selected-content JSON from export.sql and a `gcloud storage ls --long`
inventory. Outputs are data packages, a catalog, stable identities, and an audit.
No content identifiers, credentials, or source data belong in the Git repository.
"""
import argparse
import copy
import hashlib
import html
import io
import json
import re
import shutil
import sys
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import parse_qs, quote, urlsplit, urlunsplit
from urllib.request import Request, urlopen


def assert_native_bootstrap(bootstrap):
    """A source link is inventory, never a playable migration result."""
    for space in [bootstrap['space'], *bootstrap.get('orderedSpaces', [])]:
        host = (urlsplit(space.get('src') or '').hostname or '').lower()
        if space.get('type') == 'matterport' or host == 'matterport.com' or host.endswith('.matterport.com'):
            raise ValueError('A native capture is required; Matterport embeds cannot be recovered or published')


def slugify(title):
    text = unicodedata.normalize('NFKD', title).encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')[:100].rstrip('-') or 'space'


def canonical_urls(value, origins=None):
    if isinstance(value, str):
        for old, new in (origins or {}).items():
            # Rewrite only complete URL origins, including URLs in authored HTML.
            value = value.replace(old.rstrip('/') + '/', new.rstrip('/') + '/')
        if value.startswith('https://') and '<' not in value:
            url = urlsplit(value)
            value = urlunsplit((url.scheme, url.netloc, quote(url.path, safe='/%:@!$&\'()*+,;=-._~'), url.query, url.fragment))
        return value
    if isinstance(value, list):
        return [canonical_urls(item, origins) for item in value]
    if isinstance(value, dict):
        return {key: canonical_urls(item, origins) for key, item in value.items()}
    return value


def asset_url(value, origin):
    if not value:
        return ''
    value = canonical_urls(value)
    if value.startswith('https://'):
        return value
    if '://' in value or value.startswith('//'):
        raise ValueError('Unsupported asset URL')
    return origin.rstrip('/') + '/' + quote(value.lstrip('/'), safe='/()_-.,')


def read_inventory(paths):
    result = {}
    for path in paths:
        for line in path.read_text().splitlines():
            match = re.match(r'\s*(\d+)\s+\S+\s+gs://[^/]+/(.+)$', line)
            if match:
                result[match[2]] = int(match[1])
    return result


def vector(value, default):
    if isinstance(value, dict):
        return [value.get(axis, default[i]) for i, axis in enumerate('xyz')]
    return value if value is not None else default


def normalize_graph(records):
    output = []
    for original in records or []:
        item = canonical_urls(copy.deepcopy(original))
        for field, default in (('position', [0, 0, 0]), ('rotation', [0, 0, 0]), ('scale', [1, 1, 1])):
            if field in item:
                item[field] = vector(item[field], default)
        if item.get('children'):
            item['children'] = normalize_graph(item['children'])
        output.append(item)
    return output


def attach_native_archive(folder, spaces, origin, output, audit):
    """Replace an exact hosted model with its verified native archive, retaining legacy identity."""
    host = urlsplit(origin)
    if host.scheme != 'https' or not host.netloc or host.username or host.query or host.fragment:
        raise ValueError('Native archive delivery requires an HTTPS asset prefix')
    manifest = json.loads((folder / 'manifest.json').read_text())
    validation = json.loads((folder / 'validation.json').read_text())
    if manifest.get('schema') != 'sphr-matterport-web-v1' or not validation.get('valid') or not validation.get('sourceVerified'):
        raise ValueError('Native archive requires a source-verified web package')
    model_id = manifest['modelId']
    matches = [space for space in spaces.values() if space['type'] == 'matterport'
               and parse_qs(urlsplit(space.get('src') or '').query).get('m') == [model_id]]
    if not matches:
        raise ValueError('Native archive does not match a recovered Matterport model')
    assets = {item['path']: item for item in manifest['assets']}
    if len(assets) != len(manifest['assets']): raise ValueError('Duplicate native asset path')
    for name, item in assets.items():
        path = (folder / name).resolve()
        if Path(name).is_absolute() or '..' in Path(name).parts or not path.is_relative_to(folder.resolve()) or not path.is_file():
            raise ValueError('Invalid native archive asset path')
        if path.stat().st_size != item['bytes'] or hashlib.sha256(path.read_bytes()).hexdigest() != item['sha256']:
            raise ValueError('Native archive asset differs from its verified manifest')
    revision = hashlib.sha256(json.dumps(manifest['assets'], sort_keys=True).encode()).hexdigest()[:16]
    base = origin.rstrip('/') + '/' + revision
    prefix = manifest['datasetUrl'].rstrip('/') + '/'
    needed = set()

    def rewrite(value):
        if isinstance(value, dict): return {key: rewrite(item) for key, item in value.items()}
        if isinstance(value, list): return [rewrite(item) for item in value]
        if isinstance(value, str) and value.startswith(prefix):
            name = value[len(prefix):]
            if name not in assets: raise ValueError('Native archive references an unverified asset')
            needed.add(name)
            return base + '/' + quote(name, safe='/()_-.,')
        return value

    bootstrap = json.loads((folder / 'bootstrap.json').read_text())
    native = rewrite(bootstrap['space'])
    graph = rewrite(bootstrap.get('tour', {}).get('tour_data', {}).get('sceneGraph', []))
    existing = native['space_data'].get('sceneGraph', [])
    by_id = {item['id']: item for item in existing}
    for item in graph:
        if item['id'] in by_id and by_id[item['id']] != item:
            raise ValueError('Conflicting archive scene graph identity')
        by_id[item['id']] = item
    native['space_data']['sceneGraph'] = list(by_id.values())
    for space in matches:
        for key in ('type', 'version', 'mesh', 'space_custom', 'space_data'):
            if key in native: space[key] = copy.deepcopy(native[key])
        space.pop('src', None)
        audit.setdefault('nativeArchives', []).append({'spaceId': space['id'], 'modelId': model_id,
            'sourceSha256': manifest['sourceSha256'], 'revision': revision, 'nodeCount': len(native['space_data']['nodes'])})
    for name in needed:
        destination = output / revision / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists() and hashlib.sha256(destination.read_bytes()).hexdigest() != assets[name]['sha256']:
            raise ValueError('Immutable native asset was changed')
        if not destination.exists(): shutil.copyfile(folder / name, destination)


def recover_space(record, inventory, origin, iiif_origin, audit):
    data = canonical_urls(copy.deepcopy(record.get('space_data') or {}))
    output = {key: record.get(key) for key in ('id', 'title', 'description', 'src', 'version', 'space_custom')}
    output['type'] = record.get('space_type') or 'spaces'
    for field in ('thumbnail', 'share_image', 'video', 'mesh'):
        output[field] = asset_url(record.get(field), origin)
    output['space_data'] = data
    if output['type'] == 'matterport':
        parsed = urlsplit(output['src'] or '')
        if parsed.scheme != 'https' or parsed.hostname != 'my.matterport.com':
            raise ValueError(f"Invalid Matterport source for record {record['id']}")
        return output
    nodes = []
    for original in data.get('nodes', data.get('navPoints', [])):
        node = copy.deepcopy(original)
        suffix = '_' + str(record['version']) if record.get('version') else ''
        faces, missing = [], []
        for face in range(6):
            base = f"spaceshare/{node['uuid']}_face{face}{suffix}"
            small, full = base + '_1024.jpg', base + '.jpg'
            if inventory.get(small, 0) > 0:
                faces.append(asset_url(small, origin))
            elif inventory.get(full, 0) > 0:
                faces.append(iiif_origin.rstrip('/') + '/' + quote(full, safe='/()_-.,') + '/full/1024,/0/default.jpg')
            else:
                missing.append(face)
        if missing:
            audit['unavailableNodes'].append({'spaceId': record['id'], 'nodeId': node['uuid'], 'missingFaces': missing})
            continue
        node.pop('image', None)  # These are calibrated cube faces, not an equirectangular image.
        node['faces'] = faces
        nodes.append(node)
    data['nodes'] = nodes
    data.pop('navPoints', None)
    if not output['mesh'] and str(record.get('source_data') or '').lower().endswith('.glb'):
        output['mesh'] = asset_url(record['source_data'], origin)
        audit['repairs'].append({'spaceId': record['id'], 'repair': 'Use existing source GLB for mesh-only entry'})
    if not nodes and not output['mesh']:
        raise ValueError(f"Native space {record['id']} has no available panorama or mesh")
    initial = data.get('initialNode')
    if initial and initial not in {node['uuid'] for node in nodes}:
        raise ValueError(f"Initial panorama is missing for space {record['id']}")
    if nodes and initial not in {node['uuid'] for node in nodes}:
        data['initialNode'] = nodes[0]['uuid']
    data['navigation'] = {'mode': 'neighbors', 'maxVisible': 8, 'minVisible': 0, 'hideActive': True, 'markerRadius': .15}
    data['sceneGraph'] = normalize_graph(data.get('sceneGraph'))
    if output['mesh']:
        transform = data.get('sceneSettings', {}).get('dollhouse') or data.get('sceneSettings', {}).get('model') or {}
        mesh = {'id': 'capture-mesh', 'type': 'model', 'file': output['mesh'], 'persistent': True,
                'raycast': True, 'unlit': True, 'fpvOpacity': 0 if nodes else 1, 'orbitOpacity': 1,
                # Legacy dollhouse rotations are radians; node group rotations are degrees.
                'position': vector(transform.get('offsetPosition'), [0, 0, 0]),
                'rotation': vector(transform.get('offsetRotation'), [0, 0, 0]), 'scale': transform.get('scale', 1)}
        if nodes:
            mesh.update(transitionMesh=True, transitionOpacity=1)
            data['navigationTransition'] = {'enabled': True, 'meshIds': ['capture-mesh'], 'opacity': 1,
                                          'navigationMs': 1100, 'meshFadeMs': 450}
        data['sceneGraph'].insert(0, mesh)
    if not nodes:
        data['noPanos'] = True
    return output


def resolve_tour_space(segment, records, related_ids):
    declared = str(segment.get('id', ''))
    references = {point['nodeUUID'] for point in segment['tourpoints'] if point.get('nodeUUID')}
    if segment.get('type') == 'matterport':
        candidates = [record for record in records.values() if record.get('space_type') == 'matterport'
                      and segment.get('mpid') and ('m=' + segment['mpid']) in (record.get('src') or '')]
        if len(candidates) == 1:
            return str(candidates[0]['id'])
    if references:
        scored = sorted(((len(references & {node['uuid'] for node in (record.get('space_data') or {}).get('nodes', [])}), key)
                         for key, record in records.items()), reverse=True)
        if scored[0][0] == len(references) and (len(scored) == 1 or scored[0][0] > scored[1][0]):
            return scored[0][1]
    if declared in records and (not references or records[declared].get('space_type') == 'matterport'):
        return declared
    if len(related_ids) == 1:
        return str(related_ids[0])
    raise ValueError(f'Cannot uniquely resolve tour space {declared}')


def recover_tour(record, records, spaces, audit):
    data = canonical_urls(copy.deepcopy(record['tour_data']))
    data['mode'] = 'guided'
    data['sceneGraph'] = normalize_graph(data.get('sceneGraph'))
    data['annotationGraph'] = normalize_graph(data.get('annotationGraph', data.get('annotations', [])))
    for annotation in data['annotationGraph']:
        annotation.setdefault('opacity', 1)
    ordered = []
    for segment in data.get('spaces', data.get('tourmodels', [])):
        resolved = resolve_tour_space(segment, records, record.get('space_ids') or [])
        if resolved != str(segment.get('id')):
            audit['repairs'].append({'tourId': record['id'], 'fromSpaceId': segment.get('id'), 'toSpaceId': resolved})
        segment['id'] = resolved
        space = spaces[resolved]
        segment['title'], segment['type'] = space['title'], space['type']
        nodes = {node['uuid']: node for node in space['space_data'].get('nodes', [])}
        for point in segment['tourpoints']:
            # The earlier viewer defined zoom as 110 minus vertical FOV.
            # Store the optical quantity explicitly instead of reinterpreting it
            # against the new viewer's narrower free-exploration default.
            point['fov'] = max(40, min(110, 110 - (point.get('zoom') or 0)))
            if space['type'] != 'matterport' and point.get('targetType') != 'MODEL':
                if point.get('viewMode') in ('DOLLHOUSE', 'FLOORPLAN'):
                    point['viewMode'] = 'ORBIT'
                aliases = {node.get('sourceLocationId'): node['uuid'] for node in nodes.values() if node.get('sourceLocationId')}
                if point.get('nodeUUID') in aliases:
                    point['nodeUUID'] = aliases[point['nodeUUID']]
                if not point.get('nodeUUID'):
                    point['nodeUUID'] = space['space_data'].get('initialNode')
                if point.get('nodeUUID') not in nodes:
                    raise ValueError(f"Tour {record['id']} references an unavailable panorama")
            if point.get('targetType') == 'MODEL' and not point.get('models'):
                models = [item for item in data['sceneGraph'] if item.get('type') == 'model']
                if len(models) != 1:
                    raise ValueError(f"Tour {record['id']} has an ambiguous model point")
                point['models'] = [models[0]['id']]
                audit['repairs'].append({'tourId': record['id'], 'repair': 'Bind empty model point to its sole authored model'})
        if space not in ordered:
            ordered.append(space)
    return {'space': ordered[0], 'orderedSpaces': ordered,
            'tour': {'id': record['id'], 'title': record['title'], 'description': record.get('description'),
                     'space_custom': record.get('space_custom'), 'tour_data': data}}


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')


def prepare_preview(url, destination):
    from PIL import Image, ImageOps
    with urlopen(Request(url, headers={'User-Agent': 'SPHR collection recovery'}), timeout=90) as response:
        content = response.read(32 * 1024 * 1024)
    with Image.open(io.BytesIO(content)) as image:
        image = ImageOps.exif_transpose(image).convert('RGB')
        image.thumbnail((1200, 800))
        image.save(destination, 'JPEG', quality=88)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--export', type=Path, required=True)
    parser.add_argument('--inventory', type=Path, action='append', required=True)
    parser.add_argument('--namespace', required=True, help='Stable source-system identity, unchanged across reruns')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--origin', required=True, help='HTTPS origin for existing source assets')
    parser.add_argument('--iiif-origin', required=True, help='HTTPS prefix for the image service')
    parser.add_argument('--origin-map', type=Path, help='Private JSON object mapping old HTTPS origins to new HTTPS origins')
    parser.add_argument('--native-archive', type=Path, action='append', default=[], help='Source-verified native web package for an exact hosted model')
    parser.add_argument('--native-origin', help='HTTPS delivery prefix; required when using --native-archive')
    parser.add_argument('--hosted-audit', type=Path, help='Source-bound report from audit-hosted.py; retains unavailable models with an explicit viewer message')
    parser.add_argument('--allow-unmigrated-customizations', action='store_true', help='Explicitly allow data recovery with unresolved source custom handlers; this does not migrate or validate those handlers')
    parser.add_argument('--allow-unavailable-nodes', action='store_true', help='Record unavailable source nodes and omit broken navigation targets')
    args = parser.parse_args()
    if args.native_archive and not args.native_origin:
        parser.error('--native-archive requires --native-origin')
    source = json.loads(args.export.read_text())
    if args.origin_map:
        origins = json.loads(args.origin_map.read_text())
        if not isinstance(origins, dict): parser.error('--origin-map must contain a JSON object')
        for old, new in origins.items():
            for value in (old, new):
                if not isinstance(value, str): parser.error('Origin mappings must be strings')
                url = urlsplit(value)
                if url.scheme != 'https' or not url.netloc or url.path not in ('', '/') or url.username or url.query or url.fragment:
                    parser.error('Origin mappings require HTTPS origins without paths or credentials')
        source = canonical_urls(source, origins)
    inventory = read_inventory(args.inventory)
    audit = {'sourceSha256': hashlib.sha256(args.export.read_bytes()).hexdigest(), 'unavailableNodes': [], 'repairs': []}
    if any('space_custom' not in record for kind in ('spaces', 'tours') for record in source[kind]):
        raise ValueError('Source export omits customization metadata; export again with the current export.sql')
    customizations = [{'kind': kind, 'id': record['id'], 'handler': record['space_custom'], 'status': 'requires-source-review'}
                      for kind in ('space', 'tour') for record in source[kind + 's'] if record.get('space_custom')]
    audit['customizations'] = customizations
    audit['customizationsComplete'] = not customizations
    if customizations and not args.allow_unmigrated_customizations:
        write_json(args.out / 'audit.json', audit)
        raise ValueError('Source custom handlers need review and data-driven migration; inspect audit.json before explicitly allowing incomplete recovery')
    records = {str(record['id']): record for record in source['spaces']}
    spaces = {key: recover_space(record, inventory, args.origin, args.iiif_origin, audit) for key, record in records.items()}
    for folder in args.native_archive:
        attach_native_archive(folder, spaces, args.native_origin, args.out / 'native-assets', audit)
    if args.hosted_audit:
        hosted = json.loads(args.hosted_audit.read_text())
        if hosted['sourceSha256'] != audit['sourceSha256']:
            raise ValueError('Hosted audit does not match the source export')
        if hosted.get('missingTourNodes'):
            raise ValueError('Hosted audit found missing authored sweep references')
        for model in hosted['models']:
            space = spaces[str(model['id'])]
            if space['type'] == 'matterport' and model.get('available') is False:
                if model['url'] != space['src']: raise ValueError('Hosted audit source URL mismatch')
                space['availability'] = {'status': 'unavailable', 'message': 'This space’s original Matterport model is currently unavailable.'}
                audit.setdefault('unavailableHosted', []).append({'spaceId': space['id'], 'title': space['title'], 'url': space['src'], 'checkedAt': hosted['checkedAt']})
    if audit['unavailableNodes'] and not args.allow_unavailable_nodes:
        write_json(args.out / 'audit.json', audit)
        raise ValueError('Source panoramas are unavailable; inspect audit.json before allowing omission')
    pending = [{'id': space['id'], 'title': space['title'], 'src': space.get('src')}
               for space in spaces.values() if space['type'] == 'matterport']
    audit['pendingNativeCaptures'] = pending
    if pending:
        write_json(args.out / 'audit.json', audit)
        raise ValueError('Native captures are required for linked Matterport sources; no embed packages were generated. See audit.json')
    entries, previews = [], []
    for kind, items in (('space', source['spaces']), ('tour', source['tours'])):
        for record in items:
            key = str(record['id'])
            scene_id = hashlib.sha256(f'{args.namespace}:{kind}:{key}'.encode()).hexdigest()[:12]
            title_slug = slugify(record['title'])
            storage_slug = f'{kind}-{key}'
            folder = args.out / storage_slug
            if kind == 'space':
                bootstrap = {'space': spaces[key]}
                if spaces[key]['space_data'].get('noPanos'):
                    bootstrap['tour'] = {'tour_data': {'mode': 'explore', 'spaces': [{'id': key, 'tourpoints': [{'viewMode': 'ORBIT'}]}]}}
            else:
                bootstrap = recover_tour(record, records, spaces, audit)
            assert_native_bootstrap(bootstrap)
            preview = asset_url(record.get('thumbnail') or record.get('share_image'), args.origin)
            if not preview:
                preview = bootstrap['space']['thumbnail']
            if not preview:
                raise ValueError(f'No preview available for {kind} {key}')
            bootstrap['ui'] = {'loadingImage': preview}
            write_json(folder / 'bootstrap.json', bootstrap)
            entry = {'sceneId': scene_id, 'titleSlug': title_slug, 'scenePath': f'/s/{scene_id}/{title_slug}',
                     'slug': storage_slug, 'title': record['title'], 'createdAt': record.get('created_at') or '',
                     'bootstrapUrl': f'/datasets/legacy/{storage_slug}/bootstrap.json',
                     'thumbnail': f'/datasets/legacy/{storage_slug}/preview.jpg',
                     'nodeCount': sum(len(space['space_data'].get('nodes', [])) for space in bootstrap.get('orderedSpaces', [bootstrap['space']])),
                     'legacy': {'kind': kind, 'id': key}, 'sourceType': bootstrap['space']['type']}
            write_json(folder / 'manifest.json', {'schema': 'sphr-legacy-v1', **entry, 'privacy': record['privacy'],
                                                'sourceSha256': audit['sourceSha256']})
            entries.append(entry)
            previews.append((preview, folder / 'preview.jpg'))
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = [pool.submit(prepare_preview, url, path) for url, path in previews if not path.exists()]
        for future in futures:
            future.result()
    write_json(args.out / 'index.json', {'schema': 'sphr-scene-index-v3', 'spaces': entries})
    audit.update(spaces=len(spaces), tours=len(source['tours']), availablePanoramas=sum(len(space['space_data'].get('nodes', [])) for space in spaces.values()))
    write_json(args.out / 'audit.json', audit)
    print(json.dumps({key: value for key, value in audit.items() if key not in ('repairs', 'unavailableNodes')}, indent=2))


if __name__ == '__main__':
    main()
