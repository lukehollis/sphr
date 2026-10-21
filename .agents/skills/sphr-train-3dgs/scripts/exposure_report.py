#!/usr/bin/env python3
"""Says whether a capture's exposure was locked or automatic, which decides the training recipe.

  /opt/venv/bin/python exposure_report.py <folder of photos or frames> [--originals <customer's photos>]

Reads EXIF exposure time, ISO and white balance from the originals when they have them (phone and camera
photos do; frames cut from a video do not) and measures how much overall brightness swings between frames.
Prints JSON with "exposure": "locked", "automatic" or "unknown" and the evidence. Frames from a phone video
report "unknown": phone video uses automatic exposure and white balance unless the person locked them,
so treat unknown phone footage as automatic.
"""
import argparse
import json
import statistics
from pathlib import Path

from PIL import Image, ExifTags, ImageStat

try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:
    pass

EXTENSIONS = {'.jpg', '.jpeg', '.png', '.heic', '.heif', '.tif', '.tiff', '.webp'}
TAGS = {name: key for key, name in ExifTags.TAGS.items()}


def exif_values(path):
    try:
        exif = Image.open(path).getexif()
        details = exif.get_ifd(0x8769) if hasattr(exif, 'get_ifd') else {}
    except Exception:
        return None
    merged = {**dict(exif), **dict(details)}
    exposure = merged.get(TAGS['ExposureTime'])
    iso = merged.get(TAGS['ISOSpeedRatings'])
    balance = merged.get(TAGS['WhiteBalance'])
    if exposure is None and iso is None:
        return None
    return {'exposure': float(exposure) if exposure else None, 'iso': float(iso if not isinstance(iso, tuple) else iso[0]) if iso else None,
            'whiteBalance': int(balance) if balance is not None else None}


def brightness(path):
    image = Image.open(path).convert('L')
    image.thumbnail((256, 256))
    return ImageStat.Stat(image).mean[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('frames', type=Path)
    parser.add_argument('--originals', type=Path, help='The customer\'s original photos, when the frames lost their EXIF')
    args = parser.parse_args()
    frames = sorted(path for path in args.frames.rglob('*') if path.suffix.lower() in EXTENSIONS)
    originals = sorted(path for path in (args.originals or args.frames).rglob('*') if path.suffix.lower() in EXTENSIONS)
    if not frames:
        raise SystemExit('No images found.')
    step = max(1, len(frames) // 60)
    levels = [brightness(path) for path in frames[::step]]
    exif = [value for value in (exif_values(path) for path in originals[::max(1, len(originals) // 60)]) if value]
    report = {'frames': len(frames), 'brightness': {'mean': round(statistics.mean(levels), 1),
              'spread': round(statistics.pstdev(levels) / max(statistics.mean(levels), 1), 3)}}
    if len(exif) >= 3:
        exposures = {value['exposure'] for value in exif if value['exposure']}
        isos = {value['iso'] for value in exif if value['iso']}
        automatic_balance = any(value['whiteBalance'] == 0 for value in exif)
        report['exif'] = {'photos': len(exif), 'exposureTimes': len(exposures), 'isoValues': len(isos), 'autoWhiteBalance': automatic_balance}
        locked = len(exposures) <= 1 and len(isos) <= 1 and not automatic_balance
        report['exposure'] = 'locked' if locked else 'automatic'
    else:
        report['exposure'] = 'unknown'
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
