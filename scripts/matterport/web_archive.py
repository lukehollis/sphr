"""Convert a local matterport-dl archive into a standard, source-bound SPHR scene.

This is an offline importer. It preserves the viewer's photographs, mesh, poses,
floor positions and graph; it never represents a web archive as measured E57 data.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
from urllib.parse import unquote, urlsplit

import numpy as np
from PIL import Image
from scipy.spatial.transform import Rotation
import trimesh

from catalog import atomic_json, scene_identity, write_matterport_index
from geometry import C, CENTERS, RIGHTS, UPS
from seams import measure_seams

SCHEMA = "sphr-matterport-web-v1"


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def local_asset(archive, url):
    """matterport-dl stores URL paths verbatim, or replaces tilde with underscore."""
    relative = unquote(urlsplit(url).path).lstrip("/")
    if not relative or ".." in Path(relative).parts:
        raise ValueError("Invalid archive asset path")
    root = archive.resolve()
    for candidate in [root / relative, root / relative.replace("~", "_")]:
        resolved = candidate.resolve()
        if not resolved.is_relative_to(root):
            raise ValueError("Archive asset escapes its source directory")
        if resolved.is_file():
            return resolved
    raise FileNotFoundError(f"Missing archived asset: {relative}")


def load_source(archive):
    source = archive / "index.html"
    text = source.read_text()
    decoder = json.JSONDecoder()
    match = re.search(r"window\.MP_PREFETCHED_MODELDATA\s*=\s*(?:parseJSON\()?", text)
    if not match:
        raise ValueError("Archive has no original prefetched model data")
    data, _ = decoder.raw_decode(text[match.end():])
    if isinstance(data, str):
        data = json.loads(data)
    queries = data["queries"]
    model = queries["GetModelPrefetch"]["data"]["model"]
    root = queries["GetRootPrefetch"]["data"]["model"]
    if model["id"] != root["id"]:
        raise ValueError("Composite/alternate models need an explicit import implementation")
    return source, model, root


def varint(data, pos):
    value = 0
    for shift in range(0, 70, 7):
        if pos >= len(data):
            raise ValueError("Truncated DAM varint")
        byte = data[pos]
        pos += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, pos
    raise ValueError("Invalid DAM varint")


def fields(data):
    """Read bounded protobuf wire records; no generated code or executable input."""
    pos = 0
    while pos < len(data):
        tag, pos = varint(data, pos)
        number, wire = tag >> 3, tag & 7
        if number == 0:
            raise ValueError("Invalid DAM field zero")
        if wire == 0:
            value, pos = varint(data, pos)
        elif wire in (1, 2, 5):
            if wire == 2:
                size, pos = varint(data, pos)
            else:
                size = 8 if wire == 1 else 4
            if pos + size > len(data):
                raise ValueError("Truncated DAM field")
            value, pos = data[pos:pos + size], pos + size
        else:
            raise ValueError(f"Unsupported DAM wire type {wire}")
        yield number, wire, value


def packed(message, number, floating):
    values = []
    for field, wire, value in fields(message):
        if field != number:
            continue
        if floating and wire in (2, 5):
            if len(value) % 4:
                raise ValueError("Invalid DAM float array")
            values.extend(np.frombuffer(value, dtype="<f4").tolist())
        elif not floating and wire == 0:
            values.append(value)
        elif not floating and wire == 2:
            pos = 0
            while pos < len(value):
                integer, pos = varint(value, pos)
                values.append(integer)
        else:
            raise ValueError("Unexpected DAM array wire type")
    return np.asarray(values, dtype=float if floating else np.int64)


def load_dam(path):
    """BinaryMesh/ChunkSimple layout independently decoded from the local DAM.

    Layout reference: willowpsychology/rogue_matterport_archiver/damfile.proto.
    Preserve every chunk, UV and triangle, including coincident texture seams.
    """
    chunks = []
    for number, wire, message in fields(path.read_bytes()):
        if number != 1:
            continue
        if wire != 2:
            raise ValueError("Invalid DAM chunk")
        parts = {n: v for n, w, v in fields(message) if w == 2}
        xyz = packed(parts[1], 1, True).reshape(-1, 3)
        uv = packed(parts[1], 2, True).reshape(-1, 2)
        faces = packed(parts[2], 1, False).reshape(-1, 3)
        material = parts[4].decode("utf-8")
        if (not len(xyz) or not len(faces) or len(uv) != len(xyz)
                or not np.isfinite(xyz).all() or not np.isfinite(uv).all()
                or faces.min() < 0 or faces.max() >= len(xyz)
                or Path(material).name != material):
            raise ValueError("Invalid DAM geometry or material")
        chunks.append({"vertices": xyz, "uv": uv, "faces": faces,
                       "material": material, "name": parts.get(3, b"").decode("utf-8")})
    if not chunks:
        raise ValueError("DAM contains no mesh chunks")
    return chunks


def position(value):
    point = np.array([value[key] for key in "xyz"], dtype=float)
    if not np.isfinite(point).all():
        raise ValueError("Non-finite source position")
    return dict(zip("xyz", (C @ point).tolist()))


def pano_quaternion(value):
    q = np.array([value[key] for key in "xyzw"], dtype=float)
    if not np.isfinite(q).all() or abs(np.linalg.norm(q) - 1) > 1e-4:
        raise ValueError("Invalid source panorama quaternion")
    # Showcase's fromVisionSweepQuaternion, followed by its unchanged face layout.
    # Source: archived showcase.js; sweep-textures in late.js loads [2,4,0,5,1,3].
    converted = Rotation.from_matrix(C @ Rotation.from_quat(q).as_matrix() @ C.T)
    return (converted * Rotation.from_euler("y", 90, degrees=True)).as_quat().tolist()


def select_skybox(pano):
    ranks = {"low": 256, "512": 512, "high": 1024, "1k": 1024, "2k": 2048, "4k": 4096}
    available = [box for box in pano["skyboxes"]
                 if box.get("status") == "available" and box.get("urlTemplate")]
    if not available:
        raise ValueError("Panorama has no available full cube images")
    if any(box["resolution"] not in ranks for box in available):
        raise ValueError("Unsupported panorama resolution")
    return max(available, key=lambda box: ranks[box["resolution"]]), ranks


def export_mesh(archive, model, target):
    candidates = [asset for asset in model["assets"]["meshes"]
                  if asset.get("status") == "available" and asset.get("format") == "dam"
                  and asset.get("resolution") == "50k"]
    if len(candidates) != 1:
        raise ValueError("Expected one available 50k DAM mesh")
    asset = candidates[0]
    source = local_asset(archive, asset["url"])
    chunks = load_dam(source)
    textures = [t for t in model["assets"]["textures"]
                if t["status"] == "available" and t["quality"] == "high"
                and t["resolution"] == asset["resolution"]]
    if len(textures) != 1:
        raise ValueError("Expected one high-quality mesh texture template")
    scene = trimesh.Scene()
    source_assets = {source}
    for index, chunk in enumerate(chunks):
        match = re.search(r"_(\d+)\.[^.]+$", chunk["material"])
        if not match:
            raise ValueError("Unsupported DAM material naming")
        texture = local_asset(archive, textures[0]["urlTemplate"].replace("<texture>", match[1]))
        if texture.name != chunk["material"]:
            raise ValueError("Texture template does not match the DAM material")
        source_assets.add(texture)
        with Image.open(texture) as image:
            bitmap = image.convert("RGB")
        material = trimesh.visual.material.PBRMaterial(
            name=chunk["material"], baseColorTexture=bitmap,
            metallicFactor=0, roughnessFactor=1, doubleSided=True)
        mesh = trimesh.Trimesh(vertices=chunk["vertices"] @ C.T, faces=chunk["faces"],
                               visual=trimesh.visual.TextureVisuals(uv=chunk["uv"], material=material),
                               process=False)
        scene.add_geometry(mesh, node_name=f"chunk-{index}", geom_name=f"chunk-{index}")
        chunk["texture"] = texture
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(scene.export(file_type="glb"))
    reread = trimesh.load(target, force="scene", process=False)
    triangles = sum(len(mesh.faces) for mesh in reread.geometry.values())
    if triangles != sum(len(chunk["faces"]) for chunk in chunks):
        raise ValueError("GLB export lost source triangles")
    return {"triangles": triangles,
            "vertices": sum(len(mesh.vertices) for mesh in reread.geometry.values()),
            "bytes": target.stat().st_size, "sha256": digest(target),
            "sourceFormat": "DAM", "sourceResolution": "50k",
            "textureCount": len(source_assets) - 1, "bounds": reread.bounds.tolist()}, source_assets


def graph_components(nodes):
    remaining = {node["uuid"] for node in nodes}
    adjacency = {node["uuid"]: set(node["neighbors"]) for node in nodes}
    for origin, targets in list(adjacency.items()):
        for target in list(targets):
            if target not in adjacency:
                raise ValueError("Unknown source neighbor")
            adjacency[target].add(origin)
    result = []
    while remaining:
        todo, found = [min(remaining)], set()
        while todo:
            node = todo.pop()
            if node in found:
                continue
            found.add(node)
            todo.extend(adjacency[node] - found)
        remaining -= found
        result.append(sorted(found))
    return sorted(result, key=len, reverse=True)


def validate_package(folder, archive=None):
    manifest = json.loads((folder / "manifest.json").read_text())
    bootstrap = json.loads((folder / "bootstrap.json").read_text())
    if manifest["schema"] != SCHEMA:
        raise ValueError("Not a web archive package")
    nodes = bootstrap["space"]["space_data"]["nodes"]
    if len(nodes) != manifest["nodeCount"] or len({n["uuid"] for n in nodes}) != len(nodes):
        raise ValueError("Node count/identity mismatch")
    for record in manifest["assets"]:
        path = (folder / record["path"]).resolve()
        if not path.is_relative_to(folder.resolve()) or not path.is_file():
            raise ValueError("Invalid or missing package asset")
        if path.stat().st_size != record["bytes"] or digest(path) != record["sha256"]:
            raise ValueError(f"Asset integrity failure: {record['path']}")
    source_by_uuid = {}
    if archive:
        _, model, _ = load_source(archive)
        source_by_uuid = {loc["pano"]["sweepUuid"]: loc for loc in model["locations"]}
        if set(source_by_uuid) != {node["uuid"] for node in nodes}:
            raise ValueError("Package does not contain every source panorama")
        for record in manifest["sourceAssets"]:
            path = (archive / record["path"]).resolve()
            if not path.is_relative_to(archive.resolve()) or digest(path) != record["sha256"]:
                raise ValueError("Source binding failed")
    seam_reports = []
    prefix = manifest["datasetUrl"] + "/"
    for node in nodes:
        if len(node["faces"]) != 6:
            raise ValueError("Incomplete cube")
        images = []
        for url in node["faces"]:
            if not url.startswith(prefix):
                raise ValueError("Runtime image is not local to the package")
            with Image.open(folder / url[len(prefix):]) as image:
                image.load()
                if image.size != tuple(node["sourceDimensions"]):
                    raise ValueError("Image dimensions changed")
                images.append(np.asarray(image.convert("RGB").resize((256, 256)), dtype=float) / 255)
        errors = measure_seams(images)
        seam_reports.append({"node": node["uuid"], "mean": float(np.mean(errors)),
                             "max": max(errors), "edges": errors})
        if archive:
            loc = source_by_uuid[node["uuid"]]
            for field, expected in [("position", position(loc["pano"]["position"])),
                                    ("floorPosition", position(loc["position"]))]:
                if not np.allclose(list(node[field].values()), list(expected.values()), atol=1e-7):
                    raise ValueError("Source position mismatch")
            expected = Rotation.from_quat(pano_quaternion(loc["pano"]["rotation"]))
            actual = Rotation.from_quat(node["quaternion"])
            if (actual.inv() * expected).magnitude() > 1e-7:
                raise ValueError("Source orientation mismatch")
            id_map = {v["id"]: v["pano"]["sweepUuid"] for v in source_by_uuid.values()}
            if set(node["neighbors"]) != {id_map[n] for n in loc["neighbors"]}:
                raise ValueError("Source navigation graph changed")
            box, _ = select_skybox(loc["pano"])
            for face, url in enumerate(node["faces"]):
                original = local_asset(archive, box["urlTemplate"].replace("<face>", str(face)))
                if digest(original) != digest(folder / url[len(prefix):]):
                    raise ValueError("Source panorama bytes changed")
    mesh_path = folder / manifest["mesh"]["path"]
    mesh = trimesh.load(mesh_path, force="scene", process=False)
    triangles = sum(len(g.faces) for g in mesh.geometry.values())
    if triangles != manifest["mesh"]["triangles"]:
        raise ValueError("Mesh triangle count mismatch")
    if any(getattr(g.visual.material, "baseColorTexture", None) is None for g in mesh.geometry.values()):
        raise ValueError("GLB is missing its texture")
    if archive:
        dam = next(asset for asset in model["assets"]["meshes"]
                   if asset.get("resolution") == "50k" and asset.get("format") == "dam")
        original_chunks = load_dam(local_asset(archive, dam["url"]))
        if len(original_chunks) != len(mesh.geometry):
            raise ValueError("Source mesh chunk count mismatch")
        for index, chunk in enumerate(original_chunks):
            geometry = mesh.geometry[f"chunk-{index}"]
            if (not np.allclose(geometry.vertices, chunk["vertices"] @ C.T, atol=1e-7)
                    or not np.array_equal(geometry.faces, chunk["faces"])
                    or not np.allclose(geometry.visual.uv, chunk["uv"], atol=1e-7)):
                raise ValueError("GLB geometry/UVs differ from the source DAM")
    components = graph_components(nodes)
    return {"schema": "sphr-matterport-web-validation-v1", "valid": True,
            "sourceVerified": archive is not None, "nodes": len(nodes), "faces": len(nodes) * 6,
            "triangles": triangles, "graphComponents": components, "seams": seam_reports,
            "registration": "Source viewer camera transforms; no E57 point/photo calibration available",
            "rawDepthAvailable": False}


def convert(archive, slug, title, public_root):
    # Reuse the established exploration/transition envelope, with no runtime fork.
    from converter import build_bootstrap

    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", slug):
        raise ValueError("Invalid storage slug")
    source, model, root = load_source(archive)
    locations = sorted(model["locations"], key=lambda loc: loc["index"])
    if not locations:
        raise ValueError("Model contains no panoramas")
    id_map = {loc["id"]: loc["pano"]["sweepUuid"] for loc in locations}
    if len(id_map) != len(locations) or len(set(id_map.values())) != len(locations):
        raise ValueError("Duplicate source panorama identity")
    directory = public_root / "datasets/matterport"
    directory.mkdir(parents=True, exist_ok=True)
    final = directory / slug
    stage = directory / f".{slug}.web-staging"
    # Never share or overwrite an in-progress staging directory.
    stage.mkdir()
    dataset_url = f"/datasets/matterport/{slug}"
    nodes, source_assets = [], {source}
    for loc in locations:
        pano = loc["pano"]
        box, ranks = select_skybox(pano)
        faces = []
        dimensions = None
        for face in range(6):
            original = local_asset(archive, box["urlTemplate"].replace("<face>", str(face)))
            with Image.open(original) as image:
                image.verify()
            with Image.open(original) as image:
                size = image.size
            expected = ranks[box["resolution"]]
            if size != (expected, expected) or (dimensions is not None and size != dimensions):
                raise ValueError("Source panorama dimensions do not match the manifest")
            dimensions = size
            target = stage / f"faces/{pano['sweepUuid']}/face{face}.jpg"
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(original, target)
            source_assets.add(original)
            faces.append(f"{dataset_url}/{target.relative_to(stage)}")
        nodes.append({"uuid": pano["sweepUuid"], "index": loc["index"], "label": pano.get("label", str(loc["index"])),
                      "position": position(pano["position"]), "floorPosition": position(loc["position"]),
                      "quaternion": pano_quaternion(pano["rotation"]),
                      "neighbors": [id_map[n] for n in loc["neighbors"]], "faces": faces,
                      "resolution": box["resolution"], "sourceDimensions": list(dimensions),
                      "sourceLocationId": loc["id"], "sourceFloorId": loc.get("floor", {}).get("id")})
    mesh_path = f"mesh/{slug}.glb"
    mesh, mesh_sources = export_mesh(archive, model, stage / mesh_path)
    source_assets.update(mesh_sources)
    mesh["path"] = mesh_path
    title = title or root["name"]
    bootstrap = build_bootstrap(slug, title, dataset_url, nodes, f"{dataset_url}/{mesh_path}")
    bootstrap["space"]["space_custom"] = "matterport-web"
    bootstrap["space"]["thumbnail"] = f"{dataset_url}/preview.jpg"
    # Respect every original edge, including edges longer than the E57-derived cap.
    distances = [np.linalg.norm(np.array(list(node["position"].values())) -
                               np.array(list(other["position"].values())))
                 for node in nodes for other in nodes if other["uuid"] in node["neighbors"]]
    bootstrap["space"]["space_data"]["navigation"]["maxDistance"] = max(distances, default=8) + 0.1
    snapshots = archive / "api/mp/models/graph_GetSnapshots.json"
    photos = json.loads(snapshots.read_text()).get("data", {}).get("model", {}).get("assets", {}).get("photos", []) if snapshots.exists() else []
    if photos:
        preview = local_asset(archive, photos[0]["url"] or photos[0]["presentationUrl"])
        source_assets.update([snapshots, preview])
    else:
        preview = stage / f"faces/{nodes[0]['uuid']}/face1.jpg"
    with Image.open(preview) as image:
        image.thumbnail((1200, 900))
        image.convert("RGB").save(stage / "preview.jpg", quality=90)
    atomic_json(stage / "bootstrap.json", bootstrap)
    source_records = [{"path": str(p.relative_to(archive)), "bytes": p.stat().st_size, "sha256": digest(p)}
                      for p in sorted(source_assets)]
    source_binding = hashlib.sha256(json.dumps(source_records, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    manifest = {"schema": SCHEMA, "title": title, "slug": slug,
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "modelId": model["id"], "sourceUrl": f"https://my.matterport.com/show/?m={model['id']}",
                "sourceSha256": source_binding, "sourceAssets": source_records,
                "datasetUrl": dataset_url, "bootstrapUrl": f"{dataset_url}/bootstrap.json",
                "nodeCount": len(nodes), "scanCount": len(nodes), "faceCount": len(nodes) * 6,
                "mesh": mesh, "coordinateConversion": "meters; three=[x,z,-y]; Showcase fromVisionSweepQuaternion",
                "limitations": ["Viewer archive, not E57: no raw measured depth or original point cloud",
                                "Mesh retains the source viewer geometry and its holes",
                                "Panoramas retain the highest available viewer resolution"],
                "assets": [{"path": str(p.relative_to(stage)), "bytes": p.stat().st_size, "sha256": digest(p)}
                           for p in sorted(stage.rglob("*")) if p.is_file()]}
    old = json.loads((final / "manifest.json").read_text()) if (final / "manifest.json").exists() else None
    if old and (old.get("schema") != SCHEMA or old.get("modelId") != model["id"]):
        raise ValueError("Existing slug belongs to a different source")
    manifest.update(scene_identity(manifest, old))
    atomic_json(stage / "manifest.json", manifest)
    report = validate_package(stage, archive)
    atomic_json(stage / "validation.json", report)
    if final.exists():
        backup = directory / f".{slug}.previous-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
        final.rename(backup)
    stage.rename(final)
    write_matterport_index(directory)
    return {"dataset": str(final), "scenePath": manifest["scenePath"], "nodes": len(nodes),
            "faces": len(nodes) * 6, "triangles": mesh["triangles"], "sourceSha256": source_binding}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, help="Original matterport-dl model directory")
    parser.add_argument("--slug")
    parser.add_argument("--title")
    parser.add_argument("--public-root", type=Path, default=Path(__file__).resolve().parents[2] / "public")
    parser.add_argument("--validate", type=Path, help="Validate an existing package; optionally bind --archive")
    args = parser.parse_args()
    if args.validate:
        print(json.dumps(validate_package(args.validate.resolve(), args.archive.resolve() if args.archive else None), indent=2))
    else:
        if not args.archive or not args.slug:
            parser.error("Conversion requires --archive and --slug")
        print(json.dumps(convert(args.archive.resolve(), args.slug, args.title, args.public_root.resolve()), indent=2))
