#!/opt/nerfstudio/bin/python
"""Renders a trained 3DGS PLY from the cameras of its COLMAP model, so splats from any trainer (Brush,
splatfacto, an uploaded PLY) can be judged against the same held-out photographs.

  /opt/nerfstudio/bin/python render_views.py --ply <scene.ply> --model <sparse/0> --out <folder>
      [--every 8] [--antialiased] [--max-size 1280]

Renders every eighth image by name (index 0, 8, 16, ...), the frames nerfstudio's interval split and Brush's
--eval-split-every 8 hold back, and names each render after its photograph so compare_renders.py can pair
them. Lens distortion is ignored, so the outer edge of a wide lens may sit a few pixels off. Needs the GPU
and the nerfstudio Python (torch and gsplat).
"""
import argparse
import struct
from pathlib import Path

import numpy as np
import torch
from gsplat import rasterization
from PIL import Image

PLY_TYPES = {'float': 'f4', 'float32': 'f4', 'double': 'f8', 'uchar': 'u1', 'uint8': 'u1', 'int': 'i4', 'uint': 'u4', 'short': 'i2', 'ushort': 'u2'}
CAMERA_PARAMS = {0: 3, 1: 4, 2: 4, 3: 5, 4: 8, 5: 8, 6: 12, 7: 5, 8: 4, 9: 5, 10: 12}


def read_ply(path):
    with open(path, 'rb') as handle:
        fields, count = [], 0
        while True:
            line = handle.readline().decode('latin1').strip()
            if line.startswith('element vertex'):
                count = int(line.split()[-1])
            elif line.startswith('property') and 'list' not in line:
                _, kind, name = line.split()
                fields.append((name, '<' + PLY_TYPES[kind]))
            elif line == 'end_header':
                break
        return np.frombuffer(handle.read(count * np.dtype(fields).itemsize), dtype=fields, count=count)


def read_cameras(model):
    cameras = {}
    with open(Path(model) / 'cameras.bin', 'rb') as handle:
        for _ in range(struct.unpack('<Q', handle.read(8))[0]):
            camera, kind, width, height = struct.unpack('<iiQQ', handle.read(24))
            params = struct.unpack(f'<{CAMERA_PARAMS[kind]}d', handle.read(8 * CAMERA_PARAMS[kind]))
            # SIMPLE_* models share one focal length; the rest list fx, fy first.
            fx, fy, cx, cy = (params[0], params[0], params[1], params[2]) if kind in (0, 2, 3) else params[:4]
            cameras[camera] = (width, height, fx, fy, cx, cy)
    return cameras


def read_images(model):
    images = []
    with open(Path(model) / 'images.bin', 'rb') as handle:
        for _ in range(struct.unpack('<Q', handle.read(8))[0]):
            values = struct.unpack('<i7di', handle.read(64))
            name = b''
            while (char := handle.read(1)) != b'\x00':
                name += char
            points = struct.unpack('<Q', handle.read(8))[0]
            handle.seek(points * 24, 1)
            w, x, y, z = values[1:5]
            rotation = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
                                 [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
                                 [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]])
            view = np.eye(4)
            view[:3, :3], view[:3, 3] = rotation, values[5:8]
            images.append((name.decode(), values[8], view))
    return sorted(images)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--ply', required=True)
    parser.add_argument('--model', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--every', type=int, default=8)
    parser.add_argument('--antialiased', action='store_true', help='Match a model trained with antialiased rasterization')
    parser.add_argument('--max-size', type=int, default=1280)
    args = parser.parse_args()

    splats = read_ply(args.ply)
    names = splats.dtype.names
    device = torch.device('cuda')
    tensor = lambda columns: torch.tensor(np.stack([splats[name] for name in columns], -1).astype(np.float32), device=device)
    means = tensor(['x', 'y', 'z'])
    quats = torch.nn.functional.normalize(tensor(['rot_0', 'rot_1', 'rot_2', 'rot_3']), dim=-1)
    scales = torch.exp(tensor(['scale_0', 'scale_1', 'scale_2']))
    opacities = torch.sigmoid(tensor(['opacity'])[:, 0])
    rest = sorted((name for name in names if name.startswith('f_rest_')), key=lambda name: int(name.split('_')[-1]))
    degree = int(round((len(rest) // 3 + 1) ** 0.5)) - 1
    colors = tensor(['f_dc_0', 'f_dc_1', 'f_dc_2'])[:, None, :]
    if rest:
        colors = torch.cat([colors, tensor(rest).reshape(len(splats), 3, -1).transpose(1, 2)], 1)

    cameras = read_cameras(args.model)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    held = read_images(args.model)[::args.every]
    for name, camera, view in held:
        width, height, fx, fy, cx, cy = cameras[camera]
        factor = min(1.0, args.max_size / max(width, height))
        w, h = round(width * factor), round(height * factor)
        K = torch.tensor([[fx * factor, 0, cx * factor], [0, fy * factor, cy * factor], [0, 0, 1]], dtype=torch.float32, device=device)
        with torch.no_grad():
            render, _, _ = rasterization(means, quats, scales, opacities, colors, torch.tensor(view, dtype=torch.float32, device=device)[None],
                                         K[None], w, h, sh_degree=degree, rasterize_mode='antialiased' if args.antialiased else 'classic')
        pixels = (render[0].clamp(0, 1).cpu().numpy() * 255).astype(np.uint8)
        Image.fromarray(pixels).save(out / f'{Path(name).stem}.jpg', quality=92)
    print(f'Rendered {len(held)} held-out views of {len(splats)} splats (SH degree {degree}) to {out}')


if __name__ == '__main__':
    main()
