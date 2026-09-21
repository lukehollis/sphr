"""Convert extracted, authored tour points onto a verified native SPHR capture.

Release selection, model transforms and visibility schedules are source data supplied
in the binding JSON, never per-tour branches in this converter or the viewer.
"""
import argparse
from copy import deepcopy
from html import escape
from html.parser import HTMLParser
import json
import math
from pathlib import Path
from urllib.parse import urljoin, urlsplit


class TourHtml(HTMLParser):
    """Retain authored copy/links without archived CSS, SVG or executable markup."""
    allowed = {'p', 'span', 'br', 'strong', 'b', 'em', 'i', 'a', 'ul', 'ol', 'li', 'sup', 'sub'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'svg'):
            self.hidden += 1
        if self.hidden or tag not in self.allowed:
            return
        attrs = dict(attrs)
        extra = ''
        if tag == 'a':
            href = attrs.get('href', '')
            if urlsplit(href).scheme in ('https', 'http') or href.startswith('/') and not href.startswith('//'):
                extra = f' href="{escape(href, quote=True)}" target="_blank" rel="noopener noreferrer"'
        # Old text used block spans; retain paragraph breaks without Tailwind styles.
        self.parts.append('<' + ('p' if tag == 'span' else tag) + extra + '>')

    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'svg'):
            self.hidden = max(0, self.hidden - 1)
            return
        if not self.hidden and tag in self.allowed and tag != 'br':
            self.parts.append('</' + ('p' if tag == 'span' else tag) + '>')

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(escape(data))


def clean_html(value):
    parser = TourHtml()
    parser.feed(value or '')
    return ''.join(parser.parts)


def convert(source, native, binding):
    if source.get('schema') != 'sphr-compiled-tour-source-v1' or not source.get('points'):
        raise ValueError('Expected extracted authored source points')
    if native['space']['type'] == 'matterport':
        raise ValueError('A native capture is required')
    bootstrap = deepcopy(native)
    nodes = bootstrap['space']['space_data'].get('nodes', [])
    by_id = {node['uuid']: node for node in nodes}
    aliases = {}
    for node in nodes:
        for key in (node['uuid'], node.get('matterport', {}).get('guid'), node.get('sourceLocationId')):
            if key:
                if key in aliases and aliases[key] != node['uuid']:
                    raise ValueError('Ambiguous source scan identity')
                aliases[key] = node['uuid']
    for key, value in binding.get('nodeAliases', {}).items():
        if value not in by_id or key in aliases and aliases[key] != value:
            raise ValueError('Invalid source scan alias')
        aliases[key] = value
    graph = deepcopy(native.get('tour', {}).get('tour_data', {}).get('sceneGraph', []))
    graph += deepcopy(binding.get('sceneGraph', []))
    graph_ids = [item['id'] for item in graph]
    if len(set(graph_ids)) != len(graph_ids):
        raise ValueError('Duplicate scene graph identity')
    base_models = [item['id'] for item in graph if item.get('persistent')]
    annotation_ids = {item['id'] for item in binding.get('annotationGraph', [])}
    points, receipt = [], []

    def media(value):
        for old, new in binding.get('originMap', {}).items():
            if value.startswith(old.rstrip('/') + '/'):
                value = new.rstrip('/') + value[len(old.rstrip('/')):]
                break
        url = urljoin(binding['mediaBase'].rstrip('/') + '/', value)
        if urlsplit(url).scheme not in ('https', 'http'):
            raise ValueError('Unsupported media URL')
        return url

    for index, original in enumerate(source['points']):
        sweep = original.get('sweep')
        if sweep not in aliases:
            raise ValueError(f'Stop {index + 1}: source scan {sweep} has no exact native match')
        mode = original.get('mode', 'SWEEP')
        if mode not in ('SWEEP', 'DOLLHOUSE', 'FLOORPLAN'):
            raise ValueError(f'Unsupported camera mode: {mode}')
        rotation = original.get('rotation', {})
        if not all(math.isfinite(float(rotation.get(key, 0))) for key in ('x', 'y', 'z')) or rotation.get('z', 0):
            raise ValueError('Unsupported source camera rotation')
        selected = binding.get('modelsByStop', {}).get(str(index), [])
        if any(value not in graph_ids for value in selected):
            raise ValueError('Stop references an undefined embedded model')
        annotations = binding.get('annotationsByStop', {}).get(str(index), [])
        if any(value not in annotation_ids for value in annotations):
            raise ValueError('Stop references an undefined annotation')
        files = []
        for key in ('image', 'video', 'inline_video', 'background_image', 'background_video'):
            if original.get(key):
                url = media(original[key])
                embed = urlsplit(url).hostname in ('www.youtube.com', 'www.youtube-nocookie.com') and urlsplit(url).path.startswith('/embed/')
                files.append({'url': url, 'mime_type': 'text/html' if embed else 'video/mp4' if 'video' in key else 'image/jpeg',
                              'title': original.get('name', '')})
        point = {'id': f'stop-{index + 1:03}', 'nodeUUID': aliases[sweep], 'targetType': 'NODE',
                 'viewMode': 'FPV' if mode == 'SWEEP' else 'ORBIT',
                 'rotation': {'azimuth': rotation.get('y', 0), 'polar': -89.9 if mode == 'FLOORPLAN' else rotation.get('x', 0)},
                 'fov': binding.get('fov', 75), 'zoom': 0, 'text': clean_html(original.get('content')),
                 'textPosition': original.get('position', 'left'), 'files': files,
                 'models': base_models + selected, 'annotations': annotations, 'sounds': []}
        if original.get('transition') == 'INSTANT':
            point['transition'] = 'instant'
        if original.get('map'):
            point['mapUrl'] = original['map']
        point.update(deepcopy(binding.get('pointOverrides', {}).get(str(index), {})))
        points.append(point)
        receipt.append({'stop': index + 1, 'sourceScan': sweep, 'node': aliases[sweep], 'mode': mode})
    bootstrap['tour'] = {'id': binding['tourId'], 'title': binding['title'], 'tour_data': {
        'mode': 'guided', 'defaultShowText': True, 'sceneGraph': graph,
        'annotationGraph': deepcopy(binding.get('annotationGraph', [])),
        'spaces': [{'id': bootstrap['space']['id'], 'type': 'spaces', 'tourpoints': points}]}}
    bootstrap['space']['space_data']['initialNode'] = points[0]['nodeUUID']
    bootstrap['space']['space_data']['initialRotation'] = points[0]['rotation']
    bootstrap.setdefault('ui', {})['title'] = binding['title']
    return bootstrap, {'sourceSha256': source['sha256'], 'stops': receipt, 'models': graph_ids,
                       'mediaCount': sum(len(point['files']) for point in points)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source', 'native', 'binding', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    bootstrap, receipt = convert(*(json.loads(getattr(args, name).read_text()) for name in ('source', 'native', 'binding')))
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / 'bootstrap.json').write_text(json.dumps(bootstrap, ensure_ascii=False, indent=2) + '\n')
    (args.output / 'source-binding.json').write_text(json.dumps(receipt, indent=2) + '\n')
