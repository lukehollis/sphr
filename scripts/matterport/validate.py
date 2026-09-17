"""Validate a real generated package, including every scan's seams and geometry."""

import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
from PIL import Image
from scipy.spatial.transform import Rotation
import trimesh
from geometry import C, CENTERS, RIGHTS, UPS
from seams import measure_seams, assess_seams


def validate_source_nodes(source, nodes, expected_hash):
    import pye57

    source = Path(source)
    hasher = hashlib.sha256()
    with source.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            hasher.update(chunk)
    if hasher.hexdigest() != expected_hash:
        raise ValueError("Source E57 content differs from the import manifest")
    e57 = pye57.E57(str(source))
    try:
        if e57.scan_count != len(nodes):
            raise ValueError("Source E57 scan count differs from the package")
        indices = [node['matterport'].get('sourceScanIndex', index) for index, node in enumerate(nodes)]
        if sorted(indices) != list(range(e57.scan_count)) or len({node['matterport']['guid'] for node in nodes}) != len(nodes):
            raise ValueError('Source scans must be covered exactly once')
        for index, node in enumerate(nodes):
            header = e57.get_header(node["matterport"].get("sourceScanIndex", index))
            if header.guid != node["matterport"]["guid"] or not np.allclose(
                header.translation,
                node["matterport"]["sourceTranslation"],
                atol=1e-8,
                rtol=0,
            ):
                raise ValueError(f"Source scan pose differs: {node['uuid']}")
            w, x, y, z = header.rotation
            expected = C @ Rotation.from_quat([x, y, z, w]).as_matrix() @ C.T
            if not np.allclose(
                Rotation.from_quat(node["quaternion"]).as_matrix(),
                expected,
                atol=2e-4,
                rtol=0,
            ):
                raise ValueError(f"Source scan rotation differs: {node['uuid']}")
    finally:
        e57.close()
    return {"sha256": hasher.hexdigest(), "bytes": source.stat().st_size, "scanCount": len(nodes), "nodes": [node["uuid"] for node in nodes]}


def validate_package(folder, source=None, source_checks=None):
    folder = Path(folder)
    bootstrap = json.loads((folder / "bootstrap.json").read_text())
    manifest = json.loads((folder / "manifest.json").read_text())
    nodes = bootstrap["space"]["space_data"]["nodes"]
    if len(nodes) != manifest["scanCount"] or len({n["uuid"] for n in nodes}) != len(
        nodes
    ):
        raise ValueError("Missing or duplicate scans")
    if source is not None:
        if Path(source).suffix.lower() == '.zip':
            import tempfile
            from sources import ExportSources
            source_checks = []
            with tempfile.TemporaryDirectory(prefix='sphr-source-validation-') as cache:
                for source_path, part in ExportSources(source, cache, discard=True):
                    subset = [node for node in nodes if node['matterport'].get('sourcePart', 0) == part['part']]
                    expected = manifest.get('sourceParts', [{'sha256': manifest['sourceSha256']}])
                    if part['part'] >= len(expected):
                        raise ValueError('Source archive contains an unexpected E57 part')
                    if manifest.get('sourceParts') and any(part[key] != expected[part['part']][key] for key in ('member', 'bytes', 'sha256')):
                        raise ValueError('Source archive member differs from the import manifest')
                    source_checks.append(validate_source_nodes(source_path, subset, expected[part['part']]['sha256']))
        else:
            source_checks = [validate_source_nodes(source, nodes, manifest["sourceSha256"])]
    if source_checks:
        from sources import source_digest
        parts = manifest.get("sourceParts") or [{"sha256": manifest["sourceSha256"], "bytes": source_checks[0]["bytes"]}]
        if len(parts) != len(source_checks) or source_digest(parts) != manifest["sourceSha256"]:
            raise ValueError("Source-part binding differs from the manifest")
        for part, check in zip(parts, source_checks):
            if part['sha256'] != check['sha256'] or part['bytes'] != check['bytes']:
                raise ValueError("A source part differs from its verified bytes")
            if part.get('scanCount', check['scanCount']) != check['scanCount']:
                raise ValueError('A source part scan count differs from its verified coverage')
        if [uuid for check in source_checks for uuid in check['nodes']] != [node['uuid'] for node in nodes]:
            raise ValueError("Source validation does not cover every scan exactly once")
    reports = []
    warnings = []
    for node in nodes:
        group = Rotation.from_quat(node["quaternion"]).as_matrix()
        records = manifest["imageManifest"]["groups"][node["uuid"]]["sourceFaces"]
        photos = []
        for face, record in enumerate(records):
            path = folder / "faces" / node["uuid"] / f"face{face}.jpg"
            if hashlib.sha256(path.read_bytes()).hexdigest() != record["sha256"]:
                raise ValueError(f"Face content changed: {path}")
            with Image.open(path) as im:
                photos.append(
                    np.asarray(
                        im.convert("RGB").resize((512, 512), Image.Resampling.LANCZOS),
                        dtype=float,
                    )
                    / 255
                )
            # Independently reconstruct source-camera rays after the declared image rotation.
            w, x, y, z = record["sourceRotationWxyz"]
            pose = C @ Rotation.from_quat([x, y, z, w]).as_matrix()
            r, u, f = pose[:, 0], pose[:, 1], -pose[:, 2]
            r, u = [(r, u), (-u, r), (-r, -u), (u, -r)][record["rotateDegrees"] // 90]
            expected = group @ np.stack(
                [RIGHTS[face], UPS[face], CENTERS[face]], axis=1
            )
            if np.max(np.abs(expected - np.stack([r, u, f], axis=1))) > 2e-4:
                raise ValueError(
                    f"Camera/image misregistration: {node['uuid']}, face {face}"
                )
        errors = measure_seams(photos)
        try:
            seam_quality = assess_seams(
                errors,
                manifest["imageManifest"]["groups"][node["uuid"]].get(
                    "sourceSeamErrors"
                ),
            )
        except ValueError as error:
            raise ValueError(
                f"Cube seams failed for {node['uuid']}: {error}"
            ) from error
        if seam_quality["sourceLimited"]:
            warnings.append(
                {"node": node["uuid"], "type": "source-image-seam", **seam_quality}
            )
        floor = node.get("floorEstimate", {})
        if node.get('floorUnobserved'):
            if node.get('floorPosition') is not None or floor.get('method') != 'unobserved' or floor.get('access') not in {'camera-point', 'dollhouse-camera-point'}:
                raise ValueError('An unobserved floor must not invent a floor position')
            height = None
            warnings.append({'node': node['uuid'], 'type': 'unobserved-source-floor', 'access': floor['access']})
        else:
            height = node["position"]["y"] - node["floorPosition"]["y"]
            if not np.isfinite(height) or height <= 0.15:
                raise ValueError(f"Invalid measured camera height: {height}")
            if abs(height - (floor.get("cameraHeight", float("inf")) - 0.025)) > 1e-6:
                raise ValueError(f"Floor marker differs from measured plane: {node['uuid']}")
        if height is not None and height > 2.6:
            warnings.append({"node": node["uuid"], "type": "elevated-source-camera", "cameraHeightMeters": height})
        if floor.get('meshNadirUnobserved'):
            warnings.append({"node": node['uuid'], "type": "unmeasured-mesh-nadir", "floorMethod": floor['method']})
        if any(n not in {x["uuid"] for x in nodes} for n in node["neighbors"]):
            raise ValueError("Unknown navigation neighbor")
        reports.append(
            {
                "node": node["uuid"],
                "seamMean": float(np.mean(errors)),
                "seamMax": max(errors),
                "seamQuality": seam_quality,
                "cameraHeightMeters": height,
            }
        )
    mesh_path = folder / "mesh" / f"{manifest['slug']}-50k.glb"
    if (
        manifest["mesh"].get("sha256")
        and hashlib.sha256(mesh_path.read_bytes()).hexdigest()
        != manifest["mesh"]["sha256"]
    ):
        raise ValueError("Mesh content differs from the validated import")
    mesh = trimesh.load(mesh_path, force="mesh", process=False)
    if not 0 < len(mesh.faces) <= manifest["mesh"]["targetTriangles"]:
        raise ValueError("Mesh triangle budget failed")
    if not np.isfinite(mesh.vertices).all():
        raise ValueError("Nonfinite mesh vertices")
    if len(mesh.faces) != manifest["mesh"]["triangles"]:
        raise ValueError("Mesh manifest count differs from GLB")
    # Distances between scans are preserved in meters by the rigid coordinate conversion.
    scale_error = 0
    for node in nodes:
        pos = np.array([node["position"][k] for k in "xyz"])
        expected = C @ np.array(node["matterport"]["sourceTranslation"])
        scale_error = max(scale_error, float(np.linalg.norm(pos - expected)))
    if scale_error > 1e-6:
        raise ValueError("Metric scan alignment changed")
    quality = json.loads((folder / "quality.json").read_text())
    if len(quality["scans"]) != len(nodes):
        raise ValueError("Missing measured registration QA")
    return {
        "passed": True,
        "sourceVerified": bool(source_checks),
        "sourcePartCount": len(source_checks) if source_checks else 0,
        "nodeCount": len(nodes),
        "faceCount": len(nodes) * 6,
        "triangles": len(mesh.faces),
        "scaleMaxErrorMeters": scale_error,
        "seamMax": max(r["seamMax"] for r in reports),
        "warnings": warnings,
        "scans": reports,
        "pointToMeshMeters": quality["pointToMeshMeters"],
        "navigation": quality["navigation"],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path)
    parser.add_argument(
        "--source", type=Path, help="Also verify the original E57 hash and scan poses"
    )
    args = parser.parse_args()
    print(json.dumps(validate_package(args.dataset, source=args.source), indent=2))
