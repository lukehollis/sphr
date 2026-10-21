#!/usr/bin/env python3
"""Calibrated stitching of Insta360 dual-fisheye footage on the CPU (numpy + OpenCV), for build-insta360.mjs.

ffmpeg's v360 treats the two lenses as ideal 190-degree equidistant fisheyes centred in their halves. On the
ONE RS 1-Inch that is radially off by up to about 4 degrees: straight edges break at the seams (+-90 degrees from
the front) and a strip about 4 degrees wide goes missing there. The camera writes its own factory calibration
into every .insv/.insp: the 40-field "offset_v3" string holds, per lens, a unified omnidirectional (Mei) model
with radial-tangential distortion, the lens's rotation and its position. This script projects with that model,
lines the halves up in their overlap with DIS optical flow (so nearby objects meet too), evens out their colour,
blends them, and for video first merges neighbouring frames (motion-compensated), which removes most noise and
compression blocking.

The output keeps ffmpeg's frame (lens 10 at the image centre, upright for an upright camera), so tours look the
same as before apart from the seams. Without an offset_v3 calibration (older models) it exits with status 3 and
the caller falls back to ffmpeg.

    insta360_stitch.py video --a VID_..._00_n.insv --b VID_..._10_n.insv --times 1.2,3.7 --out-dir D [--width 5760]
    insta360_stitch.py still --insp IMG_...insp [IMG_...insp ...] --out F.jpg [--width 6144]

A GPU (torch) version of the same method renders the operator's own Insta360 spaces; keep the two in step.
"""
import argparse
import json
import math
import os
import re
import subprocess
import sys

import cv2
import numpy as np

NUMBERS = re.compile(rb'[0-9]_-?\d+\.\d+(?:_-?\d+(?:\.\d+)?){5,80}')
NO_CALIBRATION = 3
MIN_AGREEMENT = 0.5


def read_calibration(path):
    """[(xi, fx, fy, cx, cy, (yaw, pitch, roll), (k1, k2, k3, p1, p2), (ref_w, ref_h))] for the two lenses."""
    with open(path, 'rb') as f:
        f.seek(0, 2)
        size = f.tell()
        f.seek(max(0, size - 4_000_000))
        tail = f.read()
    for match in NUMBERS.finditer(tail):
        fields = match.group().decode().split('_')
        if len(fields) != 40 or fields[0] != '2':
            continue
        x = [float(v) for v in fields[1:]]
        if not 1.0 < x[0] < 4.0:
            continue
        lenses = []
        for k in range(2):
            p = x[k * 19:(k + 1) * 19]
            w, h = p[16] / 2, p[17]
            lenses.append({'xi': p[0], 'fx': p[1], 'fy': p[2], 'cx': p[3] - k * w, 'cy': p[4], 'angles': p[5:8],
                           'dist': p[11:16], 'ref': (w, h)})
        return lenses
    return None


def rot(axis, degrees):
    a = math.radians(degrees)
    c, s = math.cos(a), math.sin(a)
    return {'x': np.array([[1, 0, 0], [0, c, -s], [0, s, c]]), 'y': np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]]),
            'z': np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])}[axis]


class Geometry:
    """Lens images (each `stream` = (width, height) as decoded) onto the sphere. Camera frame: x right, y down,
    z forward along lens 00; lens 10 looks back. Both lenses are stored upside down."""

    def __init__(self, lenses, stream, theta_max=100.0):
        self.lenses, self.stream = lenses, stream
        self.scale = stream[1] / lenses[0]['ref'][1]
        self.cos_max = math.cos(math.radians(theta_max))
        self.R = []
        for k, lens in enumerate(lenses):
            yaw, pitch, roll = lens['angles']
            base = np.eye(3) if k == 0 else rot('x', 180)
            self.R.append((base @ rot('y', yaw) @ rot('x', pitch) @ rot('z', roll)).astype(np.float32))

    def project(self, k, dirs):
        lens = self.lenses[k]
        d = dirs @ self.R[k]
        x, y, z = d[..., 0], d[..., 1], d[..., 2]
        denom = z + lens['xi']
        mx, my = x / denom, y / denom
        r2 = mx * mx + my * my
        k1, k2, k3, p1, p2 = lens['dist']
        radial = 1 + r2 * (k1 + r2 * (k2 + r2 * k3))
        xd = mx * radial + 2 * p1 * mx * my + p2 * (r2 + 2 * mx * mx)
        yd = my * radial + p1 * (r2 + 2 * my * my) + 2 * p2 * mx * my
        w, h = self.stream
        u = (lens['fx'] * xd + lens['cx'] - lens['ref'][0] / 2) * self.scale + w / 2
        v = (lens['fy'] * yd + lens['cy'] - lens['ref'][1] / 2) * self.scale + h / 2
        ok = (z > self.cos_max) & (u >= 0) & (u <= w - 1) & (v >= 0) & (v <= h - 1)
        return u.astype(np.float32), v.astype(np.float32), ok

    def ffmpeg_rotation(self, fov=190.0, grid=(720, 360)):
        """Q0 with calibrated_direction ~ Q0 @ ffmpeg_direction (v360 dfisheye, roll 180), area-weighted."""
        w, h = grid
        true = equirect_dirs(w, h).reshape(-1, 3)
        phi = (0.5 - (np.arange(h) + 0.5) / h) * np.pi
        area = np.repeat(np.cos(phi), w)
        ew, eh = self.stream
        fr = fov / 180.0
        olds, trues, weights = [], [], []
        for k in (0, 1):
            u, v, ok = self.project(k, true)
            xn = (u + 0.5) / ew - 0.5
            xn = -xn if k == 0 else xn
            yn = (v + 0.5) / eh - 0.5
            theta = fr * np.hypot(xn, yn) * np.pi
            alpha = np.arctan2(yn, xn)
            vec = np.stack([np.sin(theta) * np.cos(alpha), np.sin(theta) * np.sin(alpha),
                            (1 if k == 1 else -1) * np.cos(theta)], -1)
            old = vec * np.array([-1.0, -1.0, 1.0])
            used = ok & (theta <= np.pi / 2)
            olds.append(old[used])
            trues.append(true[used])
            weights.append(area[used])
        a, b, wt = np.concatenate(olds), np.concatenate(trues), np.concatenate(weights)
        u_, _, vt = np.linalg.svd((b * wt[:, None]).T @ a)
        return (u_ @ np.diag([1, 1, np.sign(np.linalg.det(u_ @ vt))]) @ vt).astype(np.float32)


def equirect_dirs(width, height):
    lam = ((np.arange(width, dtype=np.float32) + 0.5) / width - 0.5) * 2 * np.pi
    phi = (0.5 - (np.arange(height, dtype=np.float32) + 0.5) / height) * np.pi
    cp, sp = np.cos(phi)[:, None], np.sin(phi)[:, None]
    return np.stack([np.sin(lam)[None] * cp, np.broadcast_to(-sp, (height, width)), np.cos(lam)[None] * cp], -1)


def sample_points(image, x, y, interpolation=cv2.INTER_LINEAR):
    """Sample image at 1-D float coordinate arrays (OpenCV's remap allows at most 32767 rows, so fold them)."""
    n = x.size
    width = 4096
    rows = -(-n // width)
    pad = rows * width - n
    mx = np.concatenate([x.astype(np.float32), np.zeros(pad, np.float32)]).reshape(rows, width)
    my = np.concatenate([y.astype(np.float32), np.zeros(pad, np.float32)]).reshape(rows, width)
    out = cv2.remap(image, mx, my, interpolation, borderMode=cv2.BORDER_REPLICATE)
    return out.reshape(rows * width, *image.shape[2:])[:n]


def smooth(x, sigma, wrap_axis=1):
    """Gaussian blur of a 2D array, wrapping along the seam (axis 1)."""
    pad = max(1, int(3 * sigma))
    padded = np.concatenate([x[:, -pad:], x, x[:, :pad]], axis=1)
    out = cv2.GaussianBlur(padded, (0, 0), sigma, borderType=cv2.BORDER_REPLICATE)
    return out[:, pad:-pad]


class Stitcher:
    def __init__(self, geometry, width, band=7.0, blend=4.0, colour_reach=30.0):
        g = self.g = geometry
        self.width, self.height = width, width // 2
        self.band, self.blend, self.reach = math.radians(band), math.radians(blend), math.radians(colour_reach)
        self.pix = 2 * math.pi / width
        q0 = g.ffmpeg_rotation()
        # Output directions in ffmpeg's frame, turned into the calibrated frame.
        self.dirs = (equirect_dirs(width, self.height).reshape(-1, 3) @ q0.T).reshape(self.height, width, 3)
        a0, a1 = g.R[0][:, 2], g.R[1][:, 2]
        n = a0 - a1
        self.n = (n / np.linalg.norm(n)).astype(np.float32)
        e1 = np.cross([0.0, 1.0, 0.0], self.n)
        self.e1 = (e1 / np.linalg.norm(e1)).astype(np.float32)
        self.e2 = np.cross(self.n, self.e1).astype(np.float32)
        self.rows = int(round(2 * self.band / self.pix))
        self.rows += self.rows % 2
        s = (np.arange(width, dtype=np.float32) + 0.5) * self.pix
        delta = self.band - (np.arange(self.rows, dtype=np.float32) + 0.5) * self.pix
        self.strip_dirs = self.seam_dirs(s[None, :], delta[:, None])
        self.maps = [g.project(k, self.dirs) for k in (0, 1)]
        self.strip_maps = [g.project(k, self.strip_dirs) for k in (0, 1)]
        self.s = (np.arctan2(self.dirs @ self.e2, self.dirs @ self.e1) % (2 * np.pi)).astype(np.float32)
        self.delta = np.arcsin(np.clip(self.dirs @ self.n, -1, 1)).astype(np.float32)
        t = np.clip((self.blend - self.delta) / (2 * self.blend), 0, 1)
        t = t * t * (3 - 2 * t)
        ok0, ok1 = self.maps[0][2], self.maps[1][2]
        self.t = np.where(ok0 & ~ok1, 0, np.where(ok1 & ~ok0, 1, t)).astype(np.float32)
        lat = np.arcsin(np.clip(-self.strip_dirs[..., 1], -1, 1))
        self.trust = np.clip((lat + math.radians(75)) / math.radians(20), 0, 1).astype(np.float32)

    def seam_dirs(self, s, delta):
        cd = np.cos(delta)
        return ((cd * np.cos(s))[..., None] * self.e1 + (cd * np.sin(s))[..., None] * self.e2 +
                np.sin(delta)[..., None] * self.n).astype(np.float32)

    def __call__(self, img0, img1):
        """Two lens images (float32 BGR, 0-1) -> equirectangular float32 BGR."""
        g = self.g
        (u0, v0, ok0), (u1, v1, ok1) = self.strip_maps
        s0 = cv2.remap(img0, u0, v0, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        s1 = cv2.remap(img1, u1, v1, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        both = (ok0 & ok1).astype(np.float32)
        mean0 = s0.mean(2)
        weight = both * (mean0 > 0.02) * (mean0 < 0.97)
        eps = 1e-3
        logratio = np.log(np.maximum(s0, eps)) - np.log(np.maximum(s1, eps))
        total = weight.sum()
        global_lr = (logratio * weight[..., None]).sum((0, 1)) / total if total > 100 else np.zeros(3, np.float32)
        # Flow between the strips (DIS on grey levels, after a rough colour match).
        grey0 = cv2.cvtColor((np.clip(s0, 0, 1) * 255).astype(np.uint8), cv2.COLOR_BGR2GRAY)
        grey1 = cv2.cvtColor((np.clip(s1 * np.exp(global_lr), 0, 1) * 255).astype(np.uint8), cv2.COLOR_BGR2GRAY)
        dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
        f = dis.calc(grey0, grey1, None)
        trust = both * self.trust
        fx = smooth(f[..., 0] * trust, 6) / np.maximum(smooth(both, 6), 1e-3)
        fy = smooth(f[..., 1] * trust, 6) / np.maximum(smooth(both, 6), 1e-3)
        limit = math.radians(3.0) / self.pix
        fx, fy = np.clip(fx, -limit, limit), np.clip(fy, -limit, limit)
        # Colour difference per position around the seam, after moving strip 10 onto strip 00.
        cols = np.arange(self.width, dtype=np.float32)[None, :].repeat(self.rows, 0)
        rows = np.arange(self.rows, dtype=np.float32)[:, None].repeat(self.width, 1)
        w1u, w1v, _ = g.project(1, self.strip_at(cols + fx, rows + fy))
        s1w = cv2.remap(img1, w1u, w1v, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        lr = np.log(np.maximum(s0, eps)) - np.log(np.maximum(s1w, eps))
        col_w = weight.sum(0)
        lr_col = (lr * weight[..., None]).sum(0) / np.maximum(col_w, 1)[:, None]          # (width, 3)
        has = (col_w > 2).astype(np.float32)
        sigma = math.radians(10) / self.pix
        num = smooth((lr_col * has[:, None]).T, sigma)                                    # (3, width)
        den = smooth(np.repeat(has[None], 3, 0), sigma)
        local = np.where(den > 1e-3, num / np.maximum(den, 1e-3), global_lr[:, None])
        # Render: lens 00 sampled at m - t*F, lens 10 at m + (1 - t)*F inside the blend band.
        t = self.t
        col = self.s / self.pix - 0.5
        row = (self.band - self.delta) / self.pix - 0.5
        inside = (t > 0) & (t < 1) & (row >= 0) & (row <= self.rows - 1)
        fxp = np.zeros_like(t)
        fyp = np.zeros_like(t)
        fxp[inside] = sample_points(fx, col[inside], row[inside])
        fyp[inside] = sample_points(fy, col[inside], row[inside])
        (mu0, mv0, _), (mu1, mv1, _) = self.maps
        mu0, mv0, mu1, mv1 = mu0.copy(), mv0.copy(), mu1.copy(), mv1.copy()
        if inside.any():
            ti = t[inside]
            a_u, a_v, _ = g.project(0, self.strip_at(col[inside] - ti * fxp[inside], row[inside] - ti * fyp[inside]))
            b_u, b_v, _ = g.project(1, self.strip_at(col[inside] + (1 - ti) * fxp[inside],
                                                       row[inside] + (1 - ti) * fyp[inside]))
            mu0[inside], mv0[inside], mu1[inside], mv1[inside] = a_u, a_v, b_u, b_v
        a = cv2.remap(img0, mu0, mv0, cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
        b = cv2.remap(img1, mu1, mv1, cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
        lr_here = np.stack([np.interp(col % self.width, np.arange(self.width), local[c], period=self.width)
                            for c in range(3)], -1)
        fade = ((1 - np.clip(np.abs(self.delta) / self.reach, 0, 1)) ** 2)[..., None]
        field = global_lr + fade * (lr_here - global_lr)
        out = a * np.exp(-0.5 * field) * (1 - t)[..., None] + b * np.exp(0.5 * field) * t[..., None]
        return np.clip(out, 0, 1)

    def agreement(self, img0, img1):
        """How well the two lenses agree in their overlap (normalised correlation of their seam strips' grey
        levels, before any flow). The ONE RS 1-Inch scores about 0.8-0.95; a calibration read with the wrong
        conventions scores far lower, and the caller then falls back to ffmpeg."""
        (u0, v0, ok0), (u1, v1, ok1) = self.strip_maps
        g0 = cv2.cvtColor(cv2.remap(img0, u0, v0, cv2.INTER_LINEAR), cv2.COLOR_BGR2GRAY)
        g1 = cv2.cvtColor(cv2.remap(img1, u1, v1, cv2.INTER_LINEAR), cv2.COLOR_BGR2GRAY)
        m = (ok0 & ok1) & (g0 > 0.02) & (g0 < 0.97)
        if m.sum() < 1000:
            return 0.0
        a, b = g0[m] - g0[m].mean(), g1[m] - g1[m].mean()
        return float((a * b).sum() / (np.sqrt((a * a).sum() * (b * b).sum()) + 1e-9))

    def strip_at(self, cols, rows):
        s = (cols + 0.5) * self.pix
        delta = self.band - (rows + 0.5) * self.pix
        return self.seam_dirs(s, delta)


# ------------------------------------------------------------------------------------------------- sources

def probe(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-print_format', 'json', '-show_streams', path],
                         capture_output=True, text=True, check=True).stdout
    return [(s['width'], s['height']) for s in json.loads(out)['streams'] if s.get('codec_type') == 'video']


def decode(path, t, count, size, stream=0, fps=30000 / 1001):
    half = count // 2
    start = max(0.0, t - half / fps)
    w, h = size
    cmd = ['ffmpeg', '-hide_banner', '-v', 'error', '-ss', f'{start:.4f}', '-i', path, '-map', f'0:v:{stream}',
           '-frames:v', str(count), '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-']
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    n = len(raw) // (w * h * 3)
    frames = [np.frombuffer(raw, np.uint8, w * h * 3, i * w * h * 3).reshape(h, w, 3) for i in range(n)]
    if not frames:
        raise RuntimeError(f'no frames at {t}s')
    return frames, min(n - 1, int(round((t - start) * fps)))


def merge(frames, centre, scale=0.5):
    """Motion-compensated average around frames[centre]: DIS flow at half size, agreement weights."""
    ref = frames[centre].astype(np.float32) / 255
    if len(frames) == 1:
        return ref
    h, w = ref.shape[:2]
    small = (int(w * scale), int(h * scale))
    gref = cv2.resize(cv2.cvtColor(frames[centre], cv2.COLOR_BGR2GRAY), small, interpolation=cv2.INTER_AREA)
    lap = cv2.Laplacian(cv2.cvtColor(frames[centre], cv2.COLOR_BGR2GRAY).astype(np.float32), cv2.CV_32F)
    sigma = max(1.5, float(1.4826 * np.median(np.abs(lap - np.median(lap))) / math.sqrt(20)))
    hp = 3.0 * sigma / 255
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    xs, ys = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    acc, wsum = ref.copy(), np.ones((h, w, 1), np.float32)
    for i, frame in enumerate(frames):
        if i == centre:
            continue
        g = cv2.resize(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), small, interpolation=cv2.INTER_AREA)
        fl = cv2.resize(dis.calc(gref, g, None), (w, h), interpolation=cv2.INTER_LINEAR) / scale
        warped = cv2.remap(frame.astype(np.float32) / 255, xs + fl[..., 0], ys + fl[..., 1], cv2.INTER_LINEAR,
                           borderMode=cv2.BORDER_REPLICATE)
        diff = cv2.blur(np.abs(warped - ref).mean(2), (5, 5))
        wt = np.exp(-(diff / hp) ** 2)[..., None]
        acc += warped * wt
        wsum += wt
    return acc / wsum


def fuse(images, agreement=0.6):
    """Mertens fusion of the exposures of a bracket that line up with the one nearest mid grey."""
    if len(images) == 1:
        return images[0]
    ref = int(np.argmin([abs(float(im.mean()) - 118) for im in images]))

    def signature(im):
        g = np.log1p(cv2.cvtColor(cv2.resize(im, (640, 320), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
                     .astype(np.float32))
        e = np.hypot(cv2.Sobel(g, cv2.CV_32F, 1, 0), cv2.Sobel(g, cv2.CV_32F, 0, 1))[40:280]
        return (e - e.mean()) / (e.std() + 1e-6)
    sig = signature(images[ref])
    chosen = [im for i, im in enumerate(images) if i == ref or float((signature(im) * sig).mean()) >= agreement]
    if len(chosen) == 1:
        return chosen[0]
    cv2.createAlignMTB().process(chosen, chosen)
    return np.clip(cv2.createMergeMertens().process(chosen) * 255, 0, 255).astype(np.uint8)


def sharpen(image, amount=0.3):
    return np.clip(image + amount * (image - cv2.GaussianBlur(image, (0, 0), 1.0)), 0, 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('video')
    p.add_argument('--a', required=True, help='The _00_ lens file')
    p.add_argument('--b', help='The _10_ lens file (single-file videos fall back to ffmpeg)')
    p.add_argument('--times', required=True)
    p.add_argument('--out-dir', required=True)
    p.add_argument('--width', type=int, default=5760)
    p.add_argument('--merge', type=int, default=5)
    p = sub.add_parser('still')
    p.add_argument('--insp', nargs='+', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--width', type=int, default=6144)
    args = parser.parse_args()
    cv2.setNumThreads(max(1, (os.cpu_count() or 2) - 1))

    if args.command == 'still':
        lenses = read_calibration(args.insp[0])
        if not lenses:
            sys.exit(NO_CALIBRATION)
        images = [cv2.imread(p, cv2.IMREAD_COLOR | cv2.IMREAD_IGNORE_ORIENTATION) for p in args.insp]
        half = images[0].shape[1] // 2
        lens0 = fuse([im[:, :half] for im in images])
        lens1 = fuse([im[:, half:] for im in images])
        stitcher = Stitcher(Geometry(lenses, (half, images[0].shape[0])), args.width)
        lens0, lens1 = lens0.astype(np.float32) / 255, lens1.astype(np.float32) / 255
        score = stitcher.agreement(lens0, lens1)
        if score < MIN_AGREEMENT:
            print(json.dumps({'fallback': f'lenses agree only {score:.2f} in their overlap'}))
            sys.exit(NO_CALIBRATION)
        out = stitcher(lens0, lens1)
        cv2.imwrite(args.out, (sharpen(out) * 255 + 0.5).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 95])
        print(json.dumps({'out': args.out, 'exposures': len(args.insp)}))
        return

    lenses = read_calibration(args.a)
    if not lenses:
        sys.exit(NO_CALIBRATION)
    streams = probe(args.a)
    if not args.b:
        sys.exit(NO_CALIBRATION)          # single-file layouts (ONE X series) are untested here: leave them to ffmpeg
    sources = [(args.a, 0, streams[0]), (args.b, 0, probe(args.b)[0])]
    stitcher = Stitcher(Geometry(lenses, sources[0][2]), args.width)
    os.makedirs(args.out_dir, exist_ok=True)
    done = []
    for t in [float(v) for v in args.times.split(',') if v]:
        lens_images = []
        for path, stream, size in sources:
            frames, centre = decode(path, t, args.merge, size, stream)
            lens_images.append(merge(frames, centre))
        if not done:
            score = stitcher.agreement(*lens_images)
            if score < MIN_AGREEMENT:
                print(json.dumps({'fallback': f'lenses agree only {score:.2f} in their overlap'}))
                sys.exit(NO_CALIBRATION)
        out = stitcher(*lens_images)
        name = os.path.join(args.out_dir, f'{int(round(t * 100)):07d}.jpg')
        cv2.imwrite(name, (sharpen(out) * 255 + 0.5).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 95])
        done.append({'t': t, 'out': name})
        print(json.dumps(done[-1]), flush=True)


if __name__ == '__main__':
    main()
