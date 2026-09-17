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
import sys
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit
from urllib.request import Request, urlopen


def slugify(title):
    text = unicodedata.normalize('NFKD', title).encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')[:100].rstrip('-') or 'space'


def canonical_urls(value):
    if isinstance(value, str):
        for service in ('static', 'iiif', 'app', 'spaces', 'tours'):
            value = value.replace(f'https://{service}.mused.org/', f'https://{service}.mused.com/')
        if value.startswith('https://') and '<' not in value:
            url = urlsplit(value)
            value = urlunsplit((url.scheme, url.netloc, quote(url.path, safe='/%:@!$&\'()*+,;=-._~'), url.query, url.fragment))
        return value
    if isinstance(value, list):
        return [canonical_urls(item) for item in value]
    if isinstance(value, dict):
        return {key: canonical_urls(item) for key, item in value.items()}
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


def recover_space(record, inventory, origin, iiif_origin, audit):
    data = canonical_urls(copy.deepcopy(record.get('space_data') or {}))
    output = {key: record.get(key) for key in ('id', 'title', 'description', 'src', 'version')}
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
            'tour': {'id': record['id'], 'title': record['title'], 'description': record.get('description'), 'tour_data': data}}


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
    parser.add_argument('--origin', default='https://static.mused.com')
    parser.add_argument('--iiif-origin', default='https://iiif.mused.com')
    parser.add_argument('--sdk-key-file', type=Path, help='Existing public Matterport Embed SDK application key')
    parser.add_argument('--allow-unavailable-nodes', action='store_true', help='Record unavailable source nodes and omit broken navigation targets')
    args = parser.parse_args()
    source = json.loads(args.export.read_text())
    inventory = read_inventory(args.inventory)
    audit = {'sourceSha256': hashlib.sha256(args.export.read_bytes()).hexdigest(), 'unavailableNodes': [], 'repairs': []}
    records = {str(record['id']): record for record in source['spaces']}
    spaces = {key: recover_space(record, inventory, args.origin, args.iiif_origin, audit) for key, record in records.items()}
    if audit['unavailableNodes'] and not args.allow_unavailable_nodes:
        write_json(args.out / 'audit.json', audit)
        raise ValueError('Source panoramas are unavailable; inspect audit.json before allowing omission')
    entries, previews = [], []
    sdk_key = args.sdk_key_file.read_text().strip() if args.sdk_key_file else None
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
            if sdk_key:
                bootstrap['integrations'] = {'matterport': {'sdkKey': sdk_key}}
            preview = asset_url(record.get('thumbnail') or record.get('share_image'), args.origin)
            if not preview:
                preview = bootstrap['space']['thumbnail']
            if not preview and bootstrap['space']['type'] == 'matterport':
                with urlopen(bootstrap['space']['src'], timeout=30) as response:
                    page = response.read(2 * 1024 * 1024).decode()
                match = re.search(r'<meta\s+property="og:image"\s+content="([^"]+)"', page)
                if match:
                    preview = html.unescape(match[1])
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
