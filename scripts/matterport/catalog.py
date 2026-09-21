"""Small, portable scene catalog. IDs live with each package, not in a database."""

import argparse
import json
import os
from pathlib import Path
import re
import tempfile
import unicodedata
import uuid


def title_slug(title):
    text = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:100].rstrip("-") or "space"


def scene_identity(manifest, previous=None):
    scene_id = (previous or {}).get("sceneId") or manifest.get("sceneId") or uuid.uuid4().hex[:12]
    if not re.fullmatch(r"[a-f0-9]{12}", scene_id):
        raise ValueError(f"Invalid sceneId: {scene_id}")
    slug = title_slug(manifest["title"])
    return {"sceneId": scene_id, "titleSlug": slug, "scenePath": f"/s/{scene_id}/{slug}"}


def matching_capture(directory, scan_guids):
    """Keep a previously imported capture's identity when a download is renamed."""
    identities = []
    for path in directory.glob('*/manifest.json'):
        if path.parent.name.startswith('.'):
            continue
        manifest = json.loads(path.read_text())
        groups = manifest.get('imageManifest', {}).get('groups', {})
        known = {group.get('associatedData3DGuid') for group in groups.values()}
        if known == set(scan_guids) and len(groups) == len(scan_guids) and None not in known:
            if manifest.get('slug') != path.parent.name:
                raise ValueError('Existing capture folder does not match its storage slug')
            identities.append(manifest)
    if len(identities) > 1:
        raise ValueError('The same source capture already has multiple catalog identities')
    return identities[0] if identities else None


def atomic_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, suffix=".tmp", delete=False) as stream:
        temp = Path(stream.name)
        try:
            json.dump(data, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
            os.chmod(temp, 0o644)
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)


def write_matterport_index(matterport_dir):
    entries, updates, ids = [], [], set()
    for manifest_path in sorted(matterport_dir.glob("*/manifest.json")):
        if manifest_path.parent.name.startswith("."):
            continue
        manifest = json.loads(manifest_path.read_text())
        if manifest.get("schema") not in {"sphr-matterport-e57-v1", "sphr-matterport-e57-v2", "sphr-matterport-web-v1"}:
            continue
        if not (manifest_path.parent / "bootstrap.json").is_file():
            continue
        identity = scene_identity(manifest)
        if identity["sceneId"] in ids:
            raise ValueError(f"Duplicate sceneId {identity['sceneId']}; each package needs a distinct identity")
        ids.add(identity["sceneId"])
        if any(manifest.get(key) != value for key, value in identity.items()):
            manifest.update(identity)
            updates.append((manifest_path, manifest))
        mesh = manifest.get("mesh") or {}
        entries.append({
            **identity,
            "slug": manifest["slug"],
            "title": manifest["title"],
            "createdAt": manifest.get("createdAt", ""),
            "bootstrapUrl": manifest["bootstrapUrl"],
            "thumbnail": f"{manifest['datasetUrl']}/preview.jpg"
                if (manifest_path.parent / "preview.jpg").is_file()
                else f"{manifest['datasetUrl']}/faces/scan-000/face1.jpg",
            "nodeCount": manifest.get("nodeCount", 0),
            "scanCount": manifest.get("scanCount", 0),
            "mesh": {key: mesh.get(key) for key in ("triangles", "vertices", "bytes")},
        })
    entries.sort(key=lambda entry: (entry["createdAt"], entry["sceneId"]), reverse=True)
    # Check the full catalog before updating any identities or replacing the index.
    for manifest_path, manifest in updates:
        atomic_json(manifest_path, manifest)
    atomic_json(matterport_dir / "index.json", {"schema": "sphr-matterport-index-v2", "spaces": entries})
    return entries


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path(__file__).resolve().parents[2] / "public/datasets/matterport")
    args = parser.parse_args()
    entries = write_matterport_index(args.directory)
    print(json.dumps({"scenes": len(entries), "links": [entry["scenePath"] for entry in entries]}, indent=2))
