#!/usr/bin/env python3
"""Read-only preflight for real downloaded Matterport ZIP/E57 exports (stdlib only)."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import struct
import zipfile


def check_header(header, size):
    if len(header) != 48 or header[:8] != b"ASTM-E57":
        raise ValueError("Missing complete ASTM-E57 header")
    declared = struct.unpack_from("<Q", header, 16)[0]
    if declared != size:
        raise ValueError(f"Incomplete E57: header declares {declared} bytes, found {size}")
    return declared


def inspect(path, crc=False, digest=False):
    path = path.expanduser().resolve(strict=True)
    result = {"source": str(path), "bytes": path.stat().st_size}
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as archive:
            files = [item for item in archive.infolist() if not item.is_dir() and item.filename.lower().endswith(".e57")]
            if not files:
                raise ValueError("ZIP contains no E57 files")
            parts = []
            for item in files:
                with archive.open(item) as stream:
                    check_header(stream.read(48), item.file_size)
                parts.append(dict(member=item.filename, bytes=item.file_size, crc32=f"{item.CRC:08x}"))
            result.update(e57Parts=parts, e57Bytes=sum(item.file_size for item in files))
            if crc:
                bad = archive.testzip()
                if bad:
                    raise ValueError(f"ZIP CRC failed: {bad}")
            result["zipCrcChecked"] = crc
    elif path.suffix.lower() == ".e57":
        with path.open("rb") as stream:
            result["e57Bytes"] = check_header(stream.read(48), path.stat().st_size)
    else:
        raise ValueError("Provide a completed .zip or .e57 export")
    if digest:
        hasher = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
                hasher.update(chunk)
        result["inputFileSha256"] = hasher.hexdigest()
    result["headerComplete"] = True
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--downloads", type=Path, help="List candidate exports by modification time")
    source.add_argument("--source", type=Path)
    parser.add_argument("--check-crc", action="store_true", help="Read and check all ZIP members")
    parser.add_argument("--sha256", action="store_true", help="Hash the provided input file; a ZIP hash is not an E57 hash")
    args = parser.parse_args()
    if args.downloads:
        candidates = sorted((p for p in args.downloads.expanduser().iterdir() if p.is_file() and "e57" in p.name.lower()), key=lambda p: p.stat().st_mtime, reverse=True)
        result = [{"source": str(p.resolve()), "bytes": p.stat().st_size,
                   "modifiedUtc": datetime.fromtimestamp(p.stat().st_mtime, timezone.utc).isoformat(),
                   "completedExtension": p.suffix.lower() in {".zip", ".e57"}} for p in candidates]
    else:
        result = inspect(args.source, args.check_crc, args.sha256)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
