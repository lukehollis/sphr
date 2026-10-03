#!/usr/bin/env python3
"""Convert a scanned or photogrammetry mesh into one binary glTF (GLB) for the viewer.

Reads OBJ (with MTL and textures), glTF/GLB, PLY and STL with trimesh; USDZ, USD, FBX, DAE
and 3DS through Blender when it is installed (BLENDER or `blender` on PATH). Converts to
y-up meters, recenters on the floor, reduces meshes above --max-faces without losing their colour
(vertex colours are carried over; textured meshes are decimated in Blender, which keeps their UVs),
and writes a sample of surface points with colors for the preview. The JSON it prints says where the
colour comes from: "texture", "vertex", "material" or "none".

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


def find_blender():
    return os.environ.get('BLENDER') or shutil.which('blender') or next(
        (path for path in ['/Applications/Blender.app/Contents/MacOS/Blender'] if Path(path).exists()), None)


def color_source(mesh):
    """Where a mesh's colour comes from: ('texture', None), ('vertex', rgb per vertex), ('material', rgb) or ('none', None)."""
    visual = getattr(mesh, 'visual', None)
    material = getattr(visual, 'material', None)
    image = getattr(material, 'baseColorTexture', None) if material is not None else None
    if image is None and material is not None:
        image = getattr(material, 'image', None)
    if getattr(visual, 'kind', None) == 'texture' and image is not None and getattr(visual, 'uv', None) is not None:
        return 'texture', None
    colors = None
    if getattr(visual, 'kind', None) == 'vertex':
        colors = np.asarray(visual.vertex_colors)
    elif getattr(visual, 'vertex_attributes', None) and 'color' in visual.vertex_attributes:
        colors = np.asarray(visual.vertex_attributes['color'])
    if colors is not None and len(colors) == len(mesh.vertices):
        colors = colors[:, :3].astype(np.float64)
        if colors.max() <= 1.0:
            colors = colors * 255.0
        if np.ptp(colors, axis=0).max() > 2:
            return 'vertex', colors
    factor = getattr(material, 'baseColorFactor', None) if material is not None else None
    if factor is None and material is not None:
        factor = getattr(material, 'main_color', None)
    if factor is not None:
        rgb = np.asarray(factor, dtype=np.float64)[:3]
        rgb = rgb * 255.0 if rgb.max() <= 1.0 else rgb
        if np.abs(rgb - 255.0).max() > 3:
            return 'material', rgb
    return 'none', None


def texture_colors(geometry, points, face_index):
    """RGB of an image-textured mesh at surface points (in the mesh's own coordinates). trimesh's own sampler
    reads material.image, which glTF's PBR materials lack (theirs is baseColorTexture)."""
    material = geometry.visual.material
    image = getattr(material, 'baseColorTexture', None)
    if image is None:
        image = getattr(material, 'image', None)
    corners = geometry.faces[face_index]
    bary = trimesh.triangles.points_to_barycentric(geometry.vertices[corners], points)
    uvs = (np.asarray(geometry.visual.uv)[corners] * bary[:, :, None]).sum(axis=1)
    pixels = np.asarray(image.convert('RGB'))
    height, width = pixels.shape[:2]
    x = (np.mod(uvs[:, 0], 1.0) * (width - 1)).round().astype(int)
    y = ((1.0 - np.mod(uvs[:, 1], 1.0)) * (height - 1)).round().astype(int)
    colors = pixels[y, x].astype(np.float64)
    factor = getattr(material, 'baseColorFactor', None)
    if factor is not None:
        factor = np.asarray(factor, dtype=np.float64)[:3]
        colors = colors * (factor / 255.0 if factor.max() > 1.0 else factor)
    return colors


def blender_decimate(source, target, ratio):
    """Reduces every mesh with Blender's collapse decimator, which keeps UVs and so textures."""
    blender = find_blender()
    if not blender:
        raise SystemExit('Reducing a textured mesh needs Blender; install it or set BLENDER.')
    script = ('import bpy\n'
              'bpy.ops.wm.read_factory_settings(use_empty=True)\n'
              f'bpy.ops.import_scene.gltf(filepath={str(source)!r})\n'
              'for obj in [o for o in bpy.context.scene.objects if o.type == "MESH"]:\n'
              '    modifier = obj.modifiers.new("reduce", "DECIMATE")\n'
              f'    modifier.ratio = {ratio!r}\n'
              '    bpy.context.view_layer.objects.active = obj\n'
              '    bpy.ops.object.modifier_apply(modifier="reduce")\n'
              f'bpy.ops.export_scene.gltf(filepath={str(target)!r}, export_format="GLB", export_yup=True)\n')
    result = subprocess.run([blender, '-b', '--factory-startup', '--python-expr', script], capture_output=True, text=True, timeout=3600)
    if result.returncode or not target.exists():
        raise SystemExit(f'Blender could not reduce the mesh:\n{result.stdout[-2000:]}\n{result.stderr[-2000:]}')


def blender_to_glb(source, target):
    blender = find_blender()
    if not blender:
        raise SystemExit(f'{source.suffix} files need Blender; install it or set BLENDER.')
    importer = {'.usdz': 'bpy.ops.wm.usd_import', '.usd': 'bpy.ops.wm.usd_import', '.usdc': 'bpy.ops.wm.usd_import', '.usda': 'bpy.ops.wm.usd_import',
                '.fbx': 'bpy.ops.import_scene.fbx', '.dae': 'bpy.ops.wm.collada_import', '.3ds': 'bpy.ops.import_scene.max3ds',
                '.blend': None}[source.suffix.lower()]
    # Rigged parts (USDZ hoses and cables, FBX characters) are frozen into plain meshes in their first-frame
    # pose: exported as skins they can come out at the armature's scale (100x for centimetre rigs), and the
    # viewer shows a still model anyway.
    script = ('import bpy, sys\n'
              'bpy.ops.wm.read_factory_settings(use_empty=True)\n'
              + (f'{importer}(filepath={str(source)!r})\n' if importer else f'bpy.ops.wm.open_mainfile(filepath={str(source)!r})\n')
              + 'scene = bpy.context.scene\n'
              'scene.frame_set(scene.frame_start)\n'
              'depsgraph = bpy.context.evaluated_depsgraph_get()\n'
              'for obj in [o for o in scene.objects if o.type == "MESH" and any(m.type == "ARMATURE" for m in o.modifiers)]:\n'
              '    world = obj.matrix_world.copy()\n'
              '    mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph), preserve_all_data_layers=True, depsgraph=depsgraph)\n'
              '    obj.modifiers.clear()\n'
              '    if obj.data.shape_keys: obj.shape_key_clear()\n'
              '    obj.data = mesh\n'
              '    obj.parent = None\n'
              '    obj.matrix_world = world\n'
              'for armature in [o for o in scene.objects if o.type == "ARMATURE"]:\n'
              '    for child in armature.children:\n'
              '        world = child.matrix_world.copy(); child.parent = None; child.matrix_world = world\n'
              '    bpy.data.objects.remove(armature)\n'
              + f'bpy.ops.export_scene.gltf(filepath={str(target)!r}, export_format="GLB", export_yup=True, export_animations=False)\n')
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
    sources = {name: color_source(geometry) for name, geometry in scene.geometry.items() if hasattr(geometry, 'faces')}
    kinds = [kind for kind, _ in sources.values()]
    reduced = False
    if faces > args.max_faces and 'texture' in kinds:
        # Simplifying with fast_simplification would drop the UVs and with them the texture.
        with tempfile.TemporaryDirectory() as temp:
            whole, smaller = Path(temp) / 'whole.glb', Path(temp) / 'smaller.glb'
            scene.export(whole, file_type='glb')
            blender_decimate(whole, smaller, max(0.01, args.max_faces / faces))
            scene = trimesh.load(smaller, force='scene')
        sources = {name: color_source(geometry) for name, geometry in scene.geometry.items() if hasattr(geometry, 'faces')}
        reduced = True
    elif faces > args.max_faces:
        import fast_simplification
        from scipy.spatial import cKDTree
        ratio = 1 - args.max_faces / faces
        for name, geometry in list(scene.geometry.items()):
            if not hasattr(geometry, 'faces') or len(geometry.faces) < 1000:
                continue
            points, triangles = fast_simplification.simplify(geometry.vertices, geometry.faces, target_reduction=ratio)
            kind, colors = sources.get(name, ('none', None))
            if kind == 'vertex':
                # Each kept vertex takes the colour of the nearest original vertex.
                nearest = cKDTree(geometry.vertices).query(points)[1]
                rgba = np.column_stack([colors[nearest], np.full(len(points), 255.0)]).clip(0, 255).astype(np.uint8)
                visual = trimesh.visual.ColorVisuals(vertex_colors=rgba)
            elif kind == 'material':
                visual = trimesh.visual.ColorVisuals(face_colors=np.append(colors, 255).clip(0, 255).astype(np.uint8))
            else:
                visual = None
            scene.geometry[name] = trimesh.Trimesh(points, triangles, visual=visual, process=False)
            if kind in ('vertex', 'material'):
                sources[name] = color_source(scene.geometry[name])
        reduced = True
    kinds = [kind for kind, _ in sources.values()]
    colour = next((kind for kind in ('texture', 'vertex', 'material') if kind in kinds), 'none')
    low, high = scene.bounds
    center = (low + high) / 2
    scene.apply_translation([-center[0], -low[1], -center[2]])
    textured = colour == 'texture'
    args.output.parent.mkdir(parents=True, exist_ok=True)
    scene.export(args.output, file_type='glb')

    # Colored surface samples for the preview image, spread over parts by area.
    # Each part is sampled from its original geometry (scene.dump() copies drop per-vertex colour that trimesh
    # keeps in vertex_attributes), then placed with its node's transform.
    parts = []
    for node in scene.graph.nodes_geometry:
        transform, name = scene.graph[node]
        geometry = scene.geometry.get(name)
        if geometry is None or not hasattr(geometry, 'faces') or not len(geometry.faces):
            continue
        world = trimesh.Trimesh(trimesh.transform_points(geometry.vertices, transform), geometry.faces, process=False)
        parts.append((geometry, world, transform))
    total_area = sum(world.area for _, world, _ in parts) or 1
    # Photo scans carry their lighting in the texture and look right unlit; designed models (flat-coloured parts
    # with a few decals, or PBR textures with normal and roughness maps) need scene lights.
    textured_area = sum(world.area for geometry, world, _ in parts if color_source(geometry)[0] == 'texture')
    pbr_maps = any(getattr(getattr(geometry.visual, 'material', None), name, None) is not None
                   for geometry, _, _ in parts for name in ('normalTexture', 'metallicRoughnessTexture'))
    lighting = 'baked' if textured and textured_area >= 0.8 * total_area and not pbr_maps else 'shaded'
    sampled, tinted = [], []
    for geometry, world, transform in parts:
        count = max(100, int(300_000 * world.area / total_area))
        kind, source = color_source(geometry)
        colors = None
        if kind == 'texture':
            try:
                local, face_index = trimesh.sample.sample_surface(geometry, count)
                colors = texture_colors(geometry, local, face_index)
                points = trimesh.transform_points(local, transform)
            except Exception:
                colors = None
        if colors is None:
            points, face_index = trimesh.sample.sample_surface(world, count)
            if kind == 'vertex':
                colors = source[geometry.faces[face_index]].mean(axis=1)
            elif kind == 'material':
                colors = np.tile(source, (len(points), 1))
            else:
                colors = np.full((len(points), 3), 200.0)
        if kind != 'texture':
            # Scans have noisy face normals; shading from smoothed vertex normals keeps the preview from speckling.
            normals = world.vertex_normals[geometry.faces[face_index]].mean(axis=1)
            normals /= np.linalg.norm(normals, axis=1, keepdims=True).clip(1e-9)
            shade = np.clip(0.7 + 0.3 * normals @ np.array([0.3, 0.8, 0.5]), 0.55, 1.0)
            colors = colors * shade[:, None]
        sampled.append(points)
        tinted.append(colors)
    samples = np.concatenate(sampled)
    colors = np.concatenate(tinted).clip(0, 255).astype(np.uint8)
    with open(args.points, 'wb') as stream:
        stream.write(samples.astype(np.float32).tobytes())
        stream.write(colors.tobytes())
    low, high = scene.bounds
    print(json.dumps({'faces': int(faces), 'reduced': reduced, 'textured': bool(textured), 'colors': colour, 'lighting': lighting, 'up': up,
                      'bounds': [[round(float(value), 3) for value in low], [round(float(value), 3) for value in high]],
                      'points': int(len(samples)), 'output': str(args.output)}))


if __name__ == '__main__':
    main()
