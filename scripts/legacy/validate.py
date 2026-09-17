#!/usr/bin/env python3
"""Validate every recovered record, tour reference and existing runtime asset.

Cube-face existence is checked against the source inventory; initial faces and all
meshes, objects, audio and video are checked through their delivery URLs. This is
an asset receipt, not a substitute for visual/navigation verification.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import struct
from urllib.parse import unquote, urlsplit
from urllib.request import Request, urlopen
from recover import read_inventory


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inspect_url(url):
    result = {'url': url}
    try:
        with urlopen(Request(url, method='HEAD', headers={'Origin': 'https://app.mused.com'}), timeout=45) as response:
            result.update(status=response.status, size=int(response.headers.get('Content-Length', '0')),
                          contentType=response.headers.get('Content-Type'), cors=response.headers.get('Access-Control-Allow-Origin'))
        if result['size'] <= 0:
            raise ValueError('Empty asset')
        if not result['cors']:
            raise ValueError('Missing cross-origin access header')
        if urlsplit(url).path.lower().endswith('.glb'):
            with urlopen(Request(url, headers={'Range': 'bytes=0-19'}), timeout=45) as response:
                header = response.read(20)
            magic, version, length, chunk_size, chunk_type = struct.unpack('<4sIIII', header)
            if magic != b'glTF' or version != 2 or length != result['size'] or chunk_type != 0x4e4f534a:
                raise ValueError('Invalid GLB header')
            # Fetch only the JSON chunk; buffers remain on the host.
            with urlopen(Request(url, headers={'Range': f'bytes=20-{19 + chunk_size}'}), timeout=45) as response:
                if response.status == 200:
                    response.read(20)
                gltf = json.loads(response.read(chunk_size))
            result['externalResources'] = [item['uri'] for group in ('buffers', 'images') for item in gltf.get(group, [])
                                           if item.get('uri') and not item['uri'].startswith('data:')]
            if result['externalResources']:
                from urllib.parse import urljoin
                result['externalChecks'] = [inspect_url(urljoin(url, value)) for value in result['externalResources']]
                if any('error' in item for item in result['externalChecks']):
                    raise ValueError('Unavailable external GLB resource')
    except Exception as error:
        result['error'] = str(error)
    return result


def required_urls(bootstrap, inventory):
    urls = set()
    spaces = bootstrap.get('orderedSpaces', [bootstrap['space']])
    spaces_by_id = {str(space['id']): space for space in spaces}
    for space in spaces:
        data = space['space_data']
        nodes = data.get('nodes', [])
        node_ids = {node['uuid'] for node in nodes}
        if len(node_ids) != len(nodes):
            raise ValueError('Duplicate panorama identity')
        for node in nodes:
            if len(node.get('faces', [])) != 6:
                raise ValueError('Incomplete panorama')
            for face in node['faces']:
                path = unquote(urlsplit(face).path.lstrip('/'))
                if '/full/' in path:
                    path = path.split('/full/')[0]
                if inventory.get(path, 0) <= 0:
                    raise ValueError('Panorama no longer matches source inventory')
            if node['uuid'] == data.get('initialNode'):
                urls.update(node['faces'])
        if space.get('mesh'):
            urls.add(space['mesh'])
    tour = bootstrap.get('tour', {}).get('tour_data', {})
    graphs = tour.get('sceneGraph', []) + [node for space in spaces for node in space['space_data'].get('sceneGraph', [])]
    def visit(nodes):
        for node in nodes:
            if node.get('file'): urls.add(node['file'])
            visit(node.get('children', []))
    visit(graphs)
    graph_ids = {node['id'] for node in graphs}
    annotations = tour.get('annotationGraph', [])
    annotation_ids = {node['id'] for node in annotations}
    urls.update(node['file'] for node in annotations)
    audio = tour.get('audio', {})
    urls.update(value['url'] for value in audio.values())
    for segment in tour.get('spaces', []):
        space = spaces_by_id[str(segment['id'])]
        nodes = {node['uuid'] for node in space['space_data'].get('nodes', [])}
        for point in segment['tourpoints']:
            if space['type'] != 'matterport' and point.get('targetType') != 'MODEL' and point.get('nodeUUID') and point['nodeUUID'] not in nodes:
                raise ValueError('Tour references missing panorama')
            if set(point.get('models', [])) - graph_ids: raise ValueError('Tour references missing model')
            if set(point.get('annotations', point.get('overlays', []))) - annotation_ids: raise ValueError('Tour references missing annotation')
            if set(point.get('sounds', [])) - audio.keys(): raise ValueError('Tour references missing audio')
    return urls


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--inventory', type=Path, action='append', required=True)
    args = parser.parse_args()
    inventory = read_inventory(args.inventory)
    entries = json.loads((args.directory / 'index.json').read_text())['spaces']
    urls_by_entry, configs = {}, {}
    from PIL import Image
    for entry in entries:
        folder = args.directory / entry['slug']
        with Image.open(folder / 'preview.jpg') as preview: preview.verify()
        bootstrap = json.loads((folder / 'bootstrap.json').read_text())
        configs[entry['slug']] = bootstrap
        urls_by_entry[entry['slug']] = required_urls(bootstrap, inventory)
    urls = sorted(set().union(*urls_by_entry.values()))
    print(f'Checking {len(urls)} delivered assets for {len(entries)} entries', flush=True)
    with ThreadPoolExecutor(max_workers=8) as pool:
        checks = dict(zip(urls, pool.map(inspect_url, urls)))
    (args.directory / 'asset-audit.json').write_text(json.dumps(list(checks.values()), indent=2) + '\n')
    failures = [item for item in checks.values() if 'error' in item]
    for entry in entries:
        folder = args.directory / entry['slug']
        errors = [checks[url] for url in urls_by_entry[entry['slug']] if 'error' in checks[url]]
        receipt = {'passed': not errors, 'files': {name: digest(folder / name) for name in ('bootstrap.json', 'preview.jpg')},
                   'verifiedUrls': len(urls_by_entry[entry['slug']]), 'errors': errors,
                   'scope': 'Source inventory, tour references and delivered assets; browser verification recorded separately'}
        (folder / 'validation.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'entries': len(entries), 'assets': len(checks), 'failures': failures}, indent=2))
    if failures: raise SystemExit(1)


if __name__ == '__main__':
    main()
