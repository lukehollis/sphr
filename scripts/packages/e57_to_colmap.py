#!/usr/bin/env python3
"""Turns an E57 scan with calibrated photos (Matterport, Leica, NavVis, Faro) into a COLMAP model that splat
trainers can use directly, so a scan becomes 3DGS without structure from motion.

  python e57_to_colmap.py --input scan.e57 --output <folder> [--size 1600] [--max-points 400000] [--keep-down]

Writes <folder>/images/ (each pinhole photo, scaled to at most --size pixels) and <folder>/sparse/0/ with
cameras.bin, images.bin and points3D.bin: the photos' own calibrated poses and a colored sample of the laser
points to start training from. Everything stays in the scan's own axes (z up). Photos looking straight down
are left out unless --keep-down, because they show the tripod. Prints JSON with the counts.
"""
import argparse
import json
import struct
from io import BytesIO
from pathlib import Path

import numpy as np
import pye57
import pye57.libe57 as libe57
from pye57.libe57 import NodeType
from PIL import Image

CASTS = {NodeType.E57_STRUCTURE: libe57.StructureNode, NodeType.E57_VECTOR: libe57.VectorNode,
         NodeType.E57_COMPRESSED_VECTOR: libe57.CompressedVectorNode, NodeType.E57_FLOAT: libe57.FloatNode,
         NodeType.E57_INTEGER: libe57.IntegerNode, NodeType.E57_STRING: libe57.StringNode, NodeType.E57_BLOB: libe57.BlobNode}


def cast(node):
    if hasattr(node, 'childCount') or hasattr(node, 'value') or hasattr(node, 'byteCount'):
        return node
    return CASTS.get(node.type(), lambda item: item)(node)


def child(node, key):
    return cast(cast(node).get(key))


def value(node, key):
    return child(node, key).value()


def defined(node, key):
    return cast(node).isDefined(key)


def rotation_matrix(w, x, y, z):
    norm = np.sqrt(w * w + x * x + y * y + z * z)
    w, x, y, z = w / norm, x / norm, y / norm, z / norm
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
                     [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
                     [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]])


def matrix_quaternion(matrix):
    """Unit quaternion (w, x, y, z) of a rotation matrix."""
    trace = np.trace(matrix)
    if trace > 0:
        s = 0.5 / np.sqrt(trace + 1)
        return np.array([0.25 / s, (matrix[2, 1] - matrix[1, 2]) * s, (matrix[0, 2] - matrix[2, 0]) * s, (matrix[1, 0] - matrix[0, 1]) * s])
    index = int(np.argmax(np.diag(matrix)))
    j, k = (index + 1) % 3, (index + 2) % 3
    s = 2 * np.sqrt(1 + matrix[index, index] - matrix[j, j] - matrix[k, k])
    q = np.zeros(4)
    q[0] = (matrix[k, j] - matrix[j, k]) / s
    q[1 + index] = 0.25 * s
    q[1 + j] = (matrix[j, index] + matrix[index, j]) / s
    q[1 + k] = (matrix[k, index] + matrix[index, k]) / s
    return q if q[0] >= 0 else -q


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--size', type=int, default=1600, help='Longest side of the written photos')
    parser.add_argument('--max-points', type=int, default=400_000)
    parser.add_argument('--keep-down', action='store_true', help='Keep photos looking straight down')
    args = parser.parse_args()

    e57 = pye57.E57(str(args.input))
    root = e57.root
    if not defined(root, 'images2D') or child(root, 'images2D').childCount() == 0:
        raise SystemExit('This E57 has no photos; build it as a point cloud instead.')
    images_dir = args.output / 'images'
    model_dir = args.output / 'sparse' / '0'
    images_dir.mkdir(parents=True, exist_ok=True)
    model_dir.mkdir(parents=True, exist_ok=True)

    cameras, images, skipped = {}, [], []
    photos = child(root, 'images2D')
    for index in range(photos.childCount()):
        node = child(photos, index)
        if not defined(node, 'pinholeRepresentation') or not defined(node, 'pose'):
            skipped.append({'image': index, 'reason': 'not a posed pinhole photo'})
            continue
        pinhole = child(node, 'pinholeRepresentation')
        width, height = value(pinhole, 'imageWidth'), value(pinhole, 'imageHeight')
        fx = value(pinhole, 'focalLength') / value(pinhole, 'pixelWidth')
        fy = value(pinhole, 'focalLength') / value(pinhole, 'pixelHeight')
        cx, cy = value(pinhole, 'principalPointX'), value(pinhole, 'principalPointY')
        pose = child(node, 'pose')
        rotation = child(pose, 'rotation')
        # E57 cameras look along -z with +y up the image; COLMAP cameras look along +z with +y down it.
        camera_to_world = rotation_matrix(value(rotation, 'w'), value(rotation, 'x'), value(rotation, 'y'), value(rotation, 'z')) @ np.diag([1, -1, -1])
        translation = child(pose, 'translation')
        center = np.array([value(translation, 'x'), value(translation, 'y'), value(translation, 'z')])
        looking = camera_to_world[:, 2]
        if not args.keep_down and looking[2] < -0.9:
            skipped.append({'image': index, 'reason': 'looks straight down (tripod)'})
            continue
        blob = child(pinhole, 'jpegImage' if defined(pinhole, 'jpegImage') else 'pngImage')
        data = bytearray(blob.byteCount())
        blob.read(data, 0, len(data))
        with Image.open(BytesIO(bytes(data))) as photo:
            photo = photo.convert('RGB')
            scale = min(1.0, args.size / max(photo.size))
            if scale < 1:
                photo = photo.resize((round(photo.width * scale), round(photo.height * scale)), Image.Resampling.LANCZOS)
            name = f'{len(images) + 1:05d}.jpg'
            photo.save(images_dir / name, quality=94)
            factor_x, factor_y = photo.width / width, photo.height / height
        key = (photo.width, photo.height, round(fx * factor_x, 4), round(fy * factor_y, 4), round(cx * factor_x, 4), round(cy * factor_y, 4))
        camera_id = cameras.setdefault(key, len(cameras) + 1)
        world_to_camera = camera_to_world.T
        images.append((len(images) + 1, matrix_quaternion(world_to_camera), -world_to_camera @ center, camera_id, name))

    if not images:
        raise SystemExit(json.dumps({'error': 'No usable photos in the E57.', 'skipped': skipped}))

    points, colors = [], []
    per_scan = max(1, args.max_points // max(1, e57.scan_count))
    for scan in range(e57.scan_count):
        try:
            data = e57.read_scan(scan, colors=True, ignore_missing_fields=True, transform=True)
        except Exception:
            continue
        xyz = np.column_stack([data['cartesianX'], data['cartesianY'], data['cartesianZ']])
        if 'colorRed' not in data:
            continue
        rgb = np.column_stack([data['colorRed'], data['colorGreen'], data['colorBlue']]).astype(np.float64)
        if rgb.max() > 255:
            rgb /= 256
        valid = np.isfinite(xyz).all(axis=1)
        xyz, rgb = xyz[valid], rgb[valid]
        if len(xyz) > per_scan:
            pick = np.random.default_rng(scan).choice(len(xyz), per_scan, replace=False)
            xyz, rgb = xyz[pick], rgb[pick]
        points.append(xyz)
        colors.append(rgb)
    points = np.concatenate(points) if points else np.zeros((0, 3))
    colors = np.concatenate(colors).clip(0, 255).astype(np.uint8) if colors else np.zeros((0, 3), np.uint8)

    with open(model_dir / 'cameras.bin', 'wb') as handle:
        handle.write(struct.pack('<Q', len(cameras)))
        for (width, height, fx, fy, cx, cy), camera_id in cameras.items():
            handle.write(struct.pack('<iiQQ4d', camera_id, 1, width, height, fx, fy, cx, cy))  # 1 = PINHOLE
    with open(model_dir / 'images.bin', 'wb') as handle:
        handle.write(struct.pack('<Q', len(images)))
        for image_id, quaternion, translation, camera_id, name in images:
            handle.write(struct.pack('<i7di', image_id, *quaternion, *translation, camera_id))
            handle.write(name.encode() + b'\x00')
            handle.write(struct.pack('<Q', 0))
    with open(model_dir / 'points3D.bin', 'wb') as handle:
        handle.write(struct.pack('<Q', len(points)))
        for index, ((x, y, z), (r, g, b)) in enumerate(zip(points, colors)):
            handle.write(struct.pack('<Q3d3BdQ', index + 1, x, y, z, r, g, b, 0.0, 0))
    print(json.dumps({'photos': len(images), 'cameras': len(cameras), 'points': len(points), 'scans': e57.scan_count,
                      'skipped': skipped, 'output': str(args.output)}))


if __name__ == '__main__':
    main()
