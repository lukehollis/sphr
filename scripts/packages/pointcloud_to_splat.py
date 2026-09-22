#!/usr/bin/env python3
"""Convert lidar point clouds into a Gaussian splat file the viewer can stream.

Reads LAS/LAZ, E57 (every scan, with its pose), PLY and PCD point clouds, and XYZ/PTS/TXT
text points. Converts to the viewer's y-up meters, recenters large (geo-referenced)
coordinates, thins to at most --max-points with a voxel grid, and writes standard 32-byte
.splat rows: position, isotropic scale, color and identity rotation.

    python3 scripts/packages/pointcloud_to_splat.py --input scan.laz --output scene.splat [--up z] [--max-points 4000000]

Prints JSON with the point counts, voxel size, up axis and the offset removed.
Needs numpy; laspy[lazrs] for LAS/LAZ, pye57 for E57 and open3d for PLY/PCD.
"""
import argparse
import json
from pathlib import Path

import numpy as np


def read_las(path):
    import laspy
    data = laspy.read(path)
    points = np.column_stack([data.x, data.y, data.z]).astype(np.float64)
    colors = None
    if {'red', 'green', 'blue'} <= set(data.point_format.dimension_names):
        rgb = np.column_stack([data.red, data.green, data.blue]).astype(np.float64)
        if rgb.max() > 0:
            colors = (rgb / (256.0 if rgb.max() > 255 else 1.0)).clip(0, 255)
    intensity = np.asarray(data.intensity, dtype=np.float64) if 'intensity' in data.point_format.dimension_names else None
    return points, colors, intensity, 'z'


def quaternion_matrix(w, x, y, z):
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def read_e57(path):
    import pye57
    e57 = pye57.E57(str(path))
    points, colors, intensities = [], [], []
    for index in range(e57.scan_count):
        header = e57.get_header(index)
        fields = set(header.point_fields)
        data = e57.read_scan_raw(index)
        if 'cartesianX' in fields:
            local = np.column_stack([data['cartesianX'], data['cartesianY'], data['cartesianZ']])
        else:
            r, azimuth, elevation = data['sphericalRange'], data['sphericalAzimuth'], data['sphericalElevation']
            local = np.column_stack([r * np.cos(elevation) * np.cos(azimuth), r * np.cos(elevation) * np.sin(azimuth), r * np.sin(elevation)])
        valid = np.ones(len(local), dtype=bool)
        if 'cartesianInvalidState' in fields:
            valid &= np.asarray(data['cartesianInvalidState']) == 0
        rotation = quaternion_matrix(*header.rotation) if header.rotation is not None else np.eye(3)
        translation = np.asarray(header.translation if header.translation is not None else [0, 0, 0])
        points.append(local[valid] @ rotation.T + translation)
        if {'colorRed', 'colorGreen', 'colorBlue'} <= fields:
            colors.append(np.column_stack([data['colorRed'], data['colorGreen'], data['colorBlue']])[valid].astype(np.float64))
        if 'intensity' in fields:
            intensities.append(np.asarray(data['intensity'], dtype=np.float64)[valid])
    rgb = np.concatenate(colors) if len(colors) == len(points) and colors else None
    if rgb is not None and rgb.max() > 255:
        rgb = rgb / 256.0
    intensity = np.concatenate(intensities) if len(intensities) == len(points) and intensities else None
    return np.concatenate(points), rgb, intensity, 'z'


def read_open3d(path):
    import open3d as o3d
    cloud = o3d.io.read_point_cloud(str(path))
    points = np.asarray(cloud.points, dtype=np.float64)
    colors = np.asarray(cloud.colors, dtype=np.float64) * 255 if cloud.has_colors() else None
    return points, colors, None, 'y'


def read_text(path):
    rows = np.loadtxt(path, comments=('#', '//'), skiprows=1 if path.suffix.lower() == '.pts' else 0, ndmin=2)
    points = rows[:, :3]
    colors = rows[:, -3:] if rows.shape[1] >= 6 else None
    intensity = rows[:, 3] if rows.shape[1] in (4, 7) else None
    return points, colors, intensity, 'z'


READERS = {'.las': read_las, '.laz': read_las, '.e57': read_e57, '.ply': read_open3d, '.pcd': read_open3d,
           '.xyz': read_text, '.pts': read_text, '.txt': read_text, '.csv': read_text}


def height_colors(y):
    """A neutral ramp by height when the scan has no color or intensity."""
    t = (y - np.percentile(y, 2)) / max(1e-6, np.percentile(y, 98) - np.percentile(y, 2))
    t = t.clip(0, 1)[:, None]
    low, high = np.array([70, 90, 110]), np.array([235, 230, 215])
    return low + (high - low) * t


def voxel_thin(points, colors, max_points):
    """Keeps one averaged point per voxel, growing the voxel until the budget fits."""
    extent = np.percentile(points, 98, axis=0) - np.percentile(points, 2, axis=0)
    volume = max(1e-6, float(np.prod(np.maximum(extent, 0.05))))
    voxel = max(0.002, (volume / max_points) ** (1 / 3) * 0.5)
    while True:
        keys = np.floor(points / voxel).astype(np.int64)
        _, inverse, counts = np.unique(keys, axis=0, return_inverse=True, return_counts=True)
        if len(counts) <= max_points:
            break
        voxel *= 1.25
    inverse = inverse.reshape(-1)
    summed = np.zeros((len(counts), 3)); np.add.at(summed, inverse, points)
    tinted = np.zeros((len(counts), 3)); np.add.at(tinted, inverse, colors)
    return summed / counts[:, None], tinted / counts[:, None], voxel


def write_splat(path, points, colors, scale):
    rows = np.zeros(len(points), dtype=[('position', '<f4', 3), ('scale', '<f4', 3), ('color', 'u1', 4), ('rotation', 'u1', 4)])
    rows['position'] = points
    rows['scale'] = scale
    rows['color'][:, :3] = colors.clip(0, 255).round()
    rows['color'][:, 3] = 255
    rows['rotation'] = [255, 128, 128, 128]  # identity quaternion (w, x, y, z)
    rows.tofile(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--up', choices=['y', 'z'], help='Up axis of the source; LAS, E57 and text default to z, PLY and PCD to y')
    parser.add_argument('--max-points', type=int, default=4_000_000)
    args = parser.parse_args()
    reader = READERS.get(args.input.suffix.lower())
    if not reader:
        parser.error(f'Unsupported point cloud format: {args.input.suffix}')
    points, colors, intensity, up = reader(args.input)
    up = args.up or up
    source = len(points)
    finite = np.isfinite(points).all(axis=1)
    points = points[finite]
    colors = colors[finite] if colors is not None else None
    intensity = intensity[finite] if intensity is not None else None
    if not len(points):
        raise SystemExit('The file contains no points.')
    if up == 'z':
        points = np.column_stack([points[:, 0], points[:, 2], -points[:, 1]])
    offset = np.median(points, axis=0)
    offset[1] = np.percentile(points[:, 1], 2)  # floor level at y = 0
    points = points - offset
    if colors is None and intensity is not None and intensity.max() > 0:
        level = (intensity / np.percentile(intensity, 99)).clip(0, 1) * 235 + 20
        colors = np.column_stack([level, level, level])
    if colors is None:
        colors = height_colors(points[:, 1])
    if len(points) > args.max_points * 5:
        # Voxel thinning of very dense scans is bounded by a uniform random pre-sample.
        keep = np.random.default_rng(0).choice(len(points), args.max_points * 5, replace=False)
        points, colors = points[keep], colors[keep]
    points, colors, voxel = voxel_thin(points, colors, args.max_points)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    write_splat(args.output, points.astype(np.float32), colors, voxel * 0.7)
    print(json.dumps({'sourcePoints': int(source), 'points': int(len(points)), 'voxelMeters': round(float(voxel), 4), 'up': up,
                      'offset': [round(float(value), 3) for value in offset], 'output': str(args.output)}))


if __name__ == '__main__':
    main()
