#!/usr/bin/env python3
"""Convert a scanned or photogrammetry mesh into one binary glTF (GLB) for the viewer.

Reads OBJ (with MTL and textures), glTF/GLB, PLY and STL with trimesh; USDZ, USD, FBX, DAE
and 3DS through Blender when it is installed (BLENDER or `blender` on PATH). Converts to
y-up meters, recenters on the floor, reduces meshes above --max-faces, and writes a sample
of surface points with colors for the preview.

    python3 scripts/packages/mesh_to_glb.py --input scan.obj --output model.glb --points points.bin [--up y|z] [--max-faces 1500000]
"""
import argparse
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import trimesh

BLENDER_FORMATS = {'.usdz', '.usd', '.usdc', '.usda', '.fbx', '.dae', '.3ds', '.blend'}


def blender_to_glb(source, target):
    blender = os.environ.get('BLENDER') or shutil.which('blender') or next(
        (path for path in ['/Applications/Blender.app/Contents/MacOS/Blender'] if Path(path).exists()), None)
    if not blender:
        raise SystemExit(f'{source.suffix} files need Blender; install it or set BLENDER.')
    importer = {'.usdz': 'bpy.ops.wm.usd_import', '.usd': 'bpy.ops.wm.usd_import', '.usdc': 'bpy.ops.wm.usd_import', '.usda': 'bpy.ops.wm.usd_import',
                '.fbx': 'bpy.ops.import_scene.fbx', '.dae': 'bpy.ops.wm.collada_import', '.3ds': 'bpy.ops.import_scene.max3ds',
                '.blend': None}[source.suffix.lower()]
    script = ('import bpy, sys\n'
              'bpy.ops.wm.read_factory_settings(use_empty=True)\n'
              + (f'{importer}(filepath={str(source)!r})\n' if importer else f'bpy.ops.wm.open_mainfile(filepath={str(source)!r})\n')
              + f'bpy.ops.export_scene.gltf(filepath={str(target)!r}, export_format="GLB", export_yup=True)\n')
    result = subprocess.run([blender, '-b', '--factory-startup', '--python-expr', script], capture_output=True, text=True, timeout=1800)
    if result.returncode or not target.exists():
        raise SystemExit(f'Blender could not convert {source.name}:\n{result.stdout[-2000:]}\n{result.stderr[-2000:]}')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--points', type=Path, required=True, help='Preview samples: float32 xyz then uint8 rgb per point')
    parser.add_argument('--up', choices=['y', 'z'], help='Up axis of the source (glTF, OBJ and USD are usually y; STL and some PLY scans are z)')
    parser.add_argument('--max-faces', type=int, default=1_500_000)
    args = parser.parse_args()
    source = args.input
    with tempfile.TemporaryDirectory() as temp:
        if source.suffix.lower() in BLENDER_FORMATS:
            converted = Path(temp) / 'converted.glb'
            blender_to_glb(source, converted)
            source = converted
        scene = trimesh.load(source, force='scene')
    if not scene.geometry:
        raise SystemExit('The file contains no mesh.')
    up = args.up or ('z' if args.input.suffix.lower() == '.stl' else 'y')
    if up == 'z':
        scene.apply_transform(trimesh.transformations.rotation_matrix(-np.pi / 2, [1, 0, 0]))
    faces = sum(len(geometry.faces) for geometry in scene.geometry.values() if hasattr(geometry, 'faces'))
    reduced = False
    if faces > args.max_faces:
        import fast_simplification
        ratio = 1 - args.max_faces / faces
        for name, geometry in list(scene.geometry.items()):
            if not hasattr(geometry, 'faces') or len(geometry.faces) < 1000:
                continue
            points, triangles = fast_simplification.simplify(geometry.vertices, geometry.faces, target_reduction=ratio)
            scene.geometry[name] = trimesh.Trimesh(points, triangles, visual=geometry.visual if len(points) == len(geometry.vertices) else None, process=False)
        reduced = True
    low, high = scene.bounds
    center = (low + high) / 2
    scene.apply_translation([-center[0], -low[1], -center[2]])
    textured = any(getattr(getattr(geometry, 'visual', None), 'kind', None) == 'texture' for geometry in scene.geometry.values())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    scene.export(args.output, file_type='glb')

    # Colored surface samples for the preview image, spread over parts by area.
    parts = [mesh for mesh in scene.dump() if hasattr(mesh, 'faces') and len(mesh.faces)]
    total_area = sum(mesh.area for mesh in parts) or 1
    sampled, tinted = [], []
    for mesh in parts:
        count = max(100, int(300_000 * mesh.area / total_area))
        try:
            points, face_index, colors = trimesh.sample.sample_surface(mesh, count, sample_color=True)
            colors = np.asarray(colors)[:, :3].astype(np.float64)
        except Exception:
            points, face_index = trimesh.sample.sample_surface(mesh, count)
            try:
                colors = mesh.visual.to_color().face_colors[face_index][:, :3].astype(np.float64)
            except Exception:
                colors = np.full((len(points), 3), 200.0)
        if not textured:
            shade = np.clip(0.55 + 0.45 * mesh.face_normals[face_index] @ np.array([0.3, 0.8, 0.5]), 0.35, 1.0)
            colors = colors * shade[:, None]
        sampled.append(points)
        tinted.append(colors)
    samples = np.concatenate(sampled)
    colors = np.concatenate(tinted).clip(0, 255).astype(np.uint8)
    with open(args.points, 'wb') as stream:
        stream.write(samples.astype(np.float32).tobytes())
        stream.write(colors.tobytes())
    low, high = scene.bounds
    print(json.dumps({'faces': int(faces), 'reduced': reduced, 'textured': bool(textured), 'up': up,
                      'bounds': [[round(float(value), 3) for value in low], [round(float(value), 3) for value in high]],
                      'points': int(len(samples)), 'output': str(args.output)}))


if __name__ == '__main__':
    main()
