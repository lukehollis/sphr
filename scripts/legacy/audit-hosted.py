#!/usr/bin/env python3
"""Audit original Matterport links and exact authored sweep references without changing models."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit
from urllib.request import urlopen
from recover import resolve_tour_space, write_json


def prefetched_model(page):
    match = re.search(r'window\.MP_PREFETCHED_MODELDATA\s*=\s*(?:parseJSON\()?', page)
    if not match:
        raise ValueError('No prefetched source model data')
    data, _ = json.JSONDecoder().raw_decode(page[match.end():])
    if isinstance(data, str): data = json.loads(data)
    return data.get('queries', {}).get('GetModelPrefetch', {}).get('data', {}).get('model')


def inspect(record):
    result = {'id': record['id'], 'title': record['title'], 'url': record['src']}
    try:
        url = urlsplit(record['src'])
        if url.scheme != 'https' or url.hostname != 'my.matterport.com' or not parse_qs(url.query).get('m'):
            raise ValueError('Expected an HTTPS Matterport model link')
        with urlopen(record['src'], timeout=45) as response:
            result['status'] = response.status
            model = prefetched_model(response.read(8 * 1024 * 1024).decode())
        result['available'] = bool(model)
        if model:
            result['modelId'] = model['id']
            result['nodeIds'] = sorted({value for location in model.get('locations', [])
                                       for value in (location.get('id'), (location.get('pano') or {}).get('sweepUuid')) if value})
        else:
            result['error'] = 'Source model prefetch is empty'
    except HTTPError as error:
        result.update(status=error.code, error=str(error))
        if error.code == 404: result['available'] = False
    except Exception as error:
        result['error'] = str(error)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--export', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    source = json.loads(args.export.read_text())
    records = {str(record['id']): record for record in source['spaces']}
    with ThreadPoolExecutor(max_workers=6) as pool:
        models = list(pool.map(inspect, [r for r in records.values() if r['space_type'] == 'matterport']))
    by_id = {str(model['id']): model for model in models}
    missing = []
    for tour in source['tours']:
        for segment in tour['tour_data'].get('spaces', tour['tour_data'].get('tourmodels', [])):
            key = resolve_tour_space(segment, records, tour.get('space_ids') or [])
            model = by_id.get(key)
            if not model or not model.get('available'): continue
            for index, point in enumerate(segment['tourpoints']):
                if point.get('targetType') != 'MODEL' and point.get('nodeUUID') and point['nodeUUID'] not in model['nodeIds']:
                    missing.append({'tourId': tour['id'], 'spaceId': key, 'pointIndex': index, 'nodeUUID': point['nodeUUID']})
    report = {'sourceSha256': hashlib.sha256(args.export.read_bytes()).hexdigest(),
              'checkedAt': datetime.now(timezone.utc).isoformat(), 'models': models, 'missingTourNodes': missing}
    write_json(args.out, report)
    print(json.dumps({'models': len(models), 'available': sum(m.get('available') is True for m in models),
                      'unavailable': sum(m.get('available') is False for m in models),
                      'unresolved': sum('available' not in m for m in models), 'missingTourNodes': missing}, indent=2))


if __name__ == '__main__': main()
