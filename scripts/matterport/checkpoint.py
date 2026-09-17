"""Source-bound checkpoints for retrying surface processing without repeating fusion."""
import hashlib
import json
from pathlib import Path
import numpy as np


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def parameters(args):
    return {key: getattr(args, key) for key in ('slug', 'face_size', 'depth_size', 'voxel_size', 'dataset_prefix')}


def save_inputs(directory, source, args, nodes, images, parts, checks):
    directory.mkdir(parents=True, exist_ok=True)
    saved_nodes = []
    for node in nodes:
        saved = dict(node, floorPosition=dict(node['floorPosition']))
        if not np.isfinite(saved['floorPosition']['y']):
            saved['floorPosition']['y'] = None
        saved_nodes.append(saved)
    data = {'schema': 'sphr-fusion-input-v1', 'sourceFileSha256': digest(source),
            'parameters': parameters(args), 'nodes': saved_nodes, 'imageManifest': images,
            'sourceParts': parts, 'sourceChecks': checks}
    (directory / 'inputs.json').write_text(json.dumps(data, indent=2, allow_nan=False) + '\n')


def load_inputs(directory, source, args):
    data = json.loads((directory / 'inputs.json').read_text())
    surface = json.loads((directory / 'surface.json').read_text())
    if data['schema'] != 'sphr-fusion-input-v1' or data['parameters'] != parameters(args):
        raise ValueError('Fusion checkpoint calibration or source layout parameters differ')
    if digest(source) != data['sourceFileSha256']:
        raise ValueError('Original export differs from the fusion checkpoint')
    for filename, expected in surface['hashes'].items():
        if filename not in {'inputs.json', 'measured.ply', 'samples.npy'} or digest(directory / filename) != expected:
            raise ValueError('Fusion checkpoint content changed')
    if set(surface['hashes']) != {'inputs.json', 'measured.ply', 'samples.npy'}:
        raise ValueError('Incomplete fusion checkpoint')
    for node in data['nodes']:
        if node['floorPosition']['y'] is None:
            node['floorPosition']['y'] = float('nan')
    return data, surface


def save_surface(directory, mesh, samples, reports):
    import open3d as o3d
    if not o3d.io.write_triangle_mesh(str(directory / 'measured.ply'), mesh):
        raise ValueError('Could not write measured surface checkpoint')
    np.save(directory / 'samples.npy', np.concatenate(samples), allow_pickle=False)
    receipt = {'hashes': {name: digest(directory / name) for name in ('inputs.json', 'measured.ply', 'samples.npy')},
               'reports': reports}
    (directory / 'surface.json').write_text(json.dumps(receipt, indent=2, allow_nan=False) + '\n')
