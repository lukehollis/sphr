#!/usr/bin/env python3
"""Unpack a Unity .unitypackage into a plain zip of its models and textures, keyed by
their project paths, so scripts/library/import-packs.mjs can read it like any pack.

    python3 scripts/library/unitypackage-to-zip.py <package.unitypackage> <out.zip>

A .unitypackage is a gzipped tar with one folder per asset GUID holding `pathname`
(the project path) and `asset` (the file). Only meshes and images are kept.
"""
import gzip
import re
import sys
import tempfile
import tarfile
import zipfile

KEEP = (".fbx", ".obj", ".gltf", ".glb", ".bin", ".png", ".jpg", ".jpeg", ".tga", ".psd")


def unpack(source, out, nested=False):
    """Write a package's meshes and images into `out`. Some publishers ship one inner
    package per render pipeline; the built-in pipeline's (or the only one) is opened."""
    # One streaming pass: a GUID's entries sit together, so hold an asset only until its
    # pathname arrives (or the pathname until its asset does).
    paths, pending, inner, written = {}, {}, [], 0
    # Unity writes a gzip header tarfile's own stream reader rejects; gzip reads it.
    with gzip.open(source) as raw, tarfile.open(fileobj=raw, mode="r|") as package:
        for member in package:
            guid, _, name = member.name.lstrip("./").partition("/")
            if name == "pathname":
                paths[guid] = package.extractfile(member).read().decode("utf-8").splitlines()[0].strip()
            elif name == "asset" and member.isfile():
                path = paths.get(guid)
                if path is not None and not path.lower().endswith(KEEP + (".unitypackage",)):
                    continue
                pending[guid] = package.extractfile(member).read()
            else:
                continue
            path = paths.get(guid)
            if path is not None and guid in pending:
                data = pending.pop(guid)
                if path.lower().endswith(".unitypackage"):
                    inner.append((path, data))
                elif path.lower().endswith(KEEP):
                    out.writestr(path, data)
                    written += 1
    if inner and not nested:
        path, data = sorted(inner, key=lambda item: (not re.search(r"birp|built.?in|standard", item[0], re.I), item[0]))[0]
        with tempfile.NamedTemporaryFile(suffix=".unitypackage") as temporary:
            temporary.write(data)
            temporary.flush()
            print(f"  opening inner package {path}")
            written += unpack(temporary.name, out, nested=True)
    return written


def main(source, target):
    with zipfile.ZipFile(target, "w", zipfile.ZIP_STORED) as out:
        written = unpack(source, out)
    print(f"{written} files from {source} into {target}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
