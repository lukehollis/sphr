#!/usr/bin/env python3
"""Where an Insta360 clip's usable walk starts and ends: cut the camera stand being lifted at the start and
lowered at the end. Prints {"start": s, "end": e} in seconds, or null when the IMU can't be read.

    insta360_trim.py VID_..._00_nnn.insv

Uses the camera's own IMU (telemetry-parser). While walking, the camera turns at about 10-20 deg/s; lifting or
lowering the stand is a burst of 40-90 deg/s, often with the camera tilted well over 10 degrees. Measured on the
ONE RS 1-Inch: this cuts 2-5 s at the start (lifting) and 1-2 s at the end (lowering). Kept in step with the
insta360-render skill's trim.py.
"""

import json
import sys

import numpy as np


def steady_window(path, lead=6.0, tail=5.0, margin=0.5, max_tilt=20.0):
    try:
        import telemetry_parser
        imu = telemetry_parser.Parser(path).normalized_imu()
    except Exception:  # noqa: BLE001 - no telemetry means no trim
        return None
    samples = [s for s in imu if s.get('accl') and s.get('gyro')]
    if len(samples) < 200:
        return None
    t = np.array([s['timestamp_ms'] for s in samples]) / 1000
    accel = np.array([s['accl'] for s in samples])
    gyro = np.linalg.norm(np.array([s['gyro'] for s in samples]), axis=1)
    duration = float(t[-1])
    if duration < 6:
        return 0.0, duration
    step = 0.25
    edges = np.arange(0, duration + step, step)
    which = np.clip(np.digitize(t, edges) - 1, 0, len(edges) - 2)
    count = np.maximum(np.bincount(which, minlength=len(edges) - 1), 1)
    rate = np.bincount(which, weights=gyro, minlength=len(edges) - 1) / count
    a = np.stack([np.bincount(which, weights=accel[:, k], minlength=len(edges) - 1) for k in range(3)], 1) / count[:, None]
    middle = (edges[:-1] > 0.2 * duration) & (edges[:-1] < 0.8 * duration)
    up = a[middle].mean(axis=0)
    up /= np.linalg.norm(up)
    tilt = np.degrees(np.arccos(np.clip((a @ up) / np.maximum(np.linalg.norm(a, axis=1), 1e-6), -1, 1)))
    threshold = max(2.5 * float(np.median(rate[middle])), 25.0)
    burst = (rate > threshold) | (tilt > max_tilt)
    times = edges[:-1]
    early = np.flatnonzero(burst & (times < min(lead, duration / 3)))
    late = np.flatnonzero(burst & (times > max(duration - tail, 2 * duration / 3)))
    s = float(times[early[-1]] + step + margin) if len(early) else 0.0
    e = float(times[late[0]] - margin) if len(late) else duration
    if e - s < 2.0:
        return 0.0, duration  # never trim a clip away
    return round(s, 2), round(min(e, duration), 2)


if __name__ == '__main__':
    window = steady_window(sys.argv[1])
    print(json.dumps(None if window is None else {'start': window[0], 'end': window[1]}))
