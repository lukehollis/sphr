#!/usr/bin/env python3
"""Convert a Matterport E57 export into a SPHR data package.

Outputs are data-only:

  sphr-next/public/datasets/matterport/<slug>/
    bootstrap.json
    manifest.json
    faces/<node>/face0.jpg ... face5.jpg
    mesh/<slug>-50k.glb

The SPHR app loads the generated bootstrap via:

  /?config=/datasets/matterport/<slug>/bootstrap.json
"""

from __future__ import annotations

import argparse
from io import BytesIO
import json
import math
import os
import hashlib
import re
import shutil
import time
from pathlib import Path
from typing import Any

os.environ.setdefault("OMP_NUM_THREADS", "1")

import numpy as np
import open3d as o3d
from PIL import Image
import pye57
import pye57.libe57 as libe57
import trimesh
from pye57.libe57 import NodeType
from scipy.spatial.transform import Rotation
from geometry import C, CENTERS, camera_face_assignment
from reconstruct import Fusion
from sources import ExportSources, source_digest
from texture import texture_mesh
from seams import measure_seams
from catalog import scene_identity, write_matterport_index, matching_capture


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert Matterport E57 to a SPHR data package."
    )
    parser.add_argument("--e57", required=True, type=Path)
    parser.add_argument("--slug")
    parser.add_argument("--title")
    parser.add_argument(
        "--public-root",
        default=str(Path(__file__).resolve().parents[2] / "public"),
        type=Path,
    )
    parser.add_argument(
        "--processed-root",
        default=str(Path(__file__).resolve().parents[3] / "data/processed"),
        type=Path,
    )
    parser.add_argument("--dataset-prefix", default="/datasets/matterport")
    parser.add_argument("--extraction-root", type=Path, default=os.environ.get("SPHR_MATTERPORT_EXTRACTION_ROOT"), help="Separate temporary E57 extraction storage, organized by capture slug")
    parser.add_argument("--target-triangles", default=50000, type=int)
    parser.add_argument("--voxel-size", default=0.035, type=float)
    parser.add_argument("--mesh-method", default="tsdf", choices=["tsdf"])
    parser.add_argument("--skip-images", action="store_true")
    parser.add_argument("--skip-mesh", action="store_true")
    parser.add_argument("--resume-geometry", action="store_true", help="Retry a source-bound fused-surface checkpoint after a geometry or texture failure")
    parser.add_argument("--buffer-part-images", action="store_true", help="Buffer each part's JPEGs in RAM (12 GiB limit), then write them after releasing its verified extraction cache")
    parser.add_argument("--face-size", default=2048, type=int)
    parser.add_argument("--depth-size", default=512, type=int)
    parser.add_argument("--atlas-size", default=4096, type=int)
    parser.add_argument("--discard-extracted-source", action="store_true", help="Release each extracted E57 cache after source validation; original ZIP stays intact")
    return parser.parse_args()


def cast_node(node: Any) -> Any:
    if (
        hasattr(node, "childCount")
        or hasattr(node, "value")
        or hasattr(node, "byteCount")
    ):
        return node
    node_type = node.type()
    if node_type == NodeType.E57_STRUCTURE:
        return libe57.StructureNode(node)
    if node_type == NodeType.E57_VECTOR:
        return libe57.VectorNode(node)
    if node_type == NodeType.E57_COMPRESSED_VECTOR:
        return libe57.CompressedVectorNode(node)
    if node_type == NodeType.E57_FLOAT:
        return libe57.FloatNode(node)
    if node_type == NodeType.E57_INTEGER:
        return libe57.IntegerNode(node)
    if node_type == NodeType.E57_STRING:
        return libe57.StringNode(node)
    if node_type == NodeType.E57_BLOB:
        return libe57.BlobNode(node)
    return node


def child(node: Any, key: str | int) -> Any:
    return cast_node(cast_node(node).get(key))


def value(node: Any, key: str) -> Any:
    return child(node, key).value()


def optional_value(node: Any, key: str, default: Any = None) -> Any:
    try:
        if hasattr(cast_node(node), "isDefined") and not cast_node(node).isDefined(key):
            return default
        return value(node, key)
    except Exception:
        return default


def quaternion_to_matrix(quaternion_wxyz: np.ndarray) -> np.ndarray:
    w, x, y, z = quaternion_wxyz / np.linalg.norm(quaternion_wxyz)
    return np.array(
        [
            [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * z * w, 2 * x * z + 2 * y * w],
            [2 * x * y + 2 * z * w, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * x * w],
            [2 * x * z - 2 * y * w, 2 * y * z + 2 * x * w, 1 - 2 * x * x - 2 * y * y],
        ],
        dtype=np.float64,
    )


def image_pose_quaternion(node: Any) -> np.ndarray:
    pose = child(node, "pose")
    rotation = child(pose, "rotation")
    return np.array(
        [
            value(rotation, "w"),
            value(rotation, "x"),
            value(rotation, "y"),
            value(rotation, "z"),
        ],
        dtype=np.float64,
    )


def image_translation(node: Any) -> np.ndarray:
    translation = child(child(node, "pose"), "translation")
    return np.array(
        [
            value(translation, "x"),
            value(translation, "y"),
            value(translation, "z"),
        ],
        dtype=np.float64,
    )


def extract_images(e57, dataset_dir, dataset_url, headers, face_size=2048, scan_offset=0, source_part=0, image_buffer=None):
    images = child(e57.root, "images2D")
    grouped = {}
    for index in range(images.childCount()):
        image = child(images, index)
        guid = optional_value(image, "associatedData3DGuid")
        if not guid:
            raise ValueError(f"Image {index} lacks associatedData3DGuid")
        grouped.setdefault(guid, []).append(image)
    manifest = {
        "images2D": images.childCount(),
        "orientationMethod": "calibrated-image-poses-v2",
        "groups": {},
    }
    nodes = []
    for scan_index, header in enumerate(headers):
        source = grouped.get(header.guid, [])
        if len(source) != 6:
            raise ValueError(
                f"Scan {scan_index} has {len(source)} images; exactly six calibrated pinhole images are required"
            )
        rotation = quaternion_to_matrix(np.asarray(header.rotation))
        group, assignment = camera_face_assignment(
            rotation, [quaternion_to_matrix(image_pose_quaternion(n)) for n in source]
        )
        camera = np.asarray(header.translation) @ C.T
        poses = [image_translation(n) @ C.T for n in source]
        if max(np.linalg.norm(p - camera) for p in poses) > 0.002:
            raise ValueError(
                f"Scan {scan_index}: image cameras differ from scan origin; cannot represent as a central panorama"
            )
        uuid = f"scan-{scan_offset + scan_index:03d}"
        folder = dataset_dir / "faces" / uuid
        folder.mkdir(parents=True, exist_ok=True)
        faces, records, source_photos = [], [], []
        for face, (source_index, degrees, residual) in enumerate(assignment):
            node = source[source_index]
            pinhole = child(node, "pinholeRepresentation")
            width, height = value(pinhole, "imageWidth"), value(pinhole, "imageHeight")
            fx = value(pinhole, "focalLength") / value(pinhole, "pixelWidth")
            fy = value(pinhole, "focalLength") / value(pinhole, "pixelHeight")
            if (
                max(
                    abs(fx - width / 2),
                    abs(fy - height / 2),
                    abs(value(pinhole, "principalPointX") - width / 2),
                    abs(value(pinhole, "principalPointY") - height / 2),
                )
                > 0.01
            ):
                raise ValueError(
                    f"Scan {scan_index} image is not a 90-degree centered cube face"
                )
            blob = child(
                pinhole, "jpegImage" if pinhole.isDefined("jpegImage") else "pngImage"
            )
            raw = bytes(blob.read_buffer())
            with Image.open(BytesIO(raw)) as original:
                image = original.convert("RGB")
                if degrees:
                    image = image.transpose(
                        {
                            90: Image.Transpose.ROTATE_90,
                            180: Image.Transpose.ROTATE_180,
                            270: Image.Transpose.ROTATE_270,
                        }[degrees]
                    )
                source_photos.append(
                    np.asarray(
                        image.resize((512, 512), Image.Resampling.LANCZOS), dtype=float
                    )
                    / 255
                )
                if face_size:
                    image.thumbnail((face_size, face_size), Image.Resampling.LANCZOS)
                path = folder / f"face{face}.jpg"
                if image_buffer is not None:
                    checksum = image_buffer.save(path, image)
                else:
                    image.save(path, quality=94, subsampling=0)
                    checksum = hashlib.sha256(path.read_bytes()).hexdigest()
            faces.append(f"{dataset_url}/faces/{uuid}/face{face}.jpg")
            records.append(
                {
                    "sphrFace": face,
                    "sourceImageGuid": optional_value(node, "guid"),
                    "sourceName": optional_value(node, "name"),
                    "sourceRotationWxyz": image_pose_quaternion(node).tolist(),
                    "rotateDegrees": degrees,
                    "basisResidual": residual,
                    "sourceSize": [width, height],
                    "size": list(image.size),
                    "sha256": checksum,
                }
            )
        nodes.append(
            {
                "uuid": uuid,
                "label": f"Location {scan_offset + scan_index + 1}",
                "faces": faces,
                "position": dict(zip("xyz", camera.tolist())),
                "quaternion": Rotation.from_matrix(group).as_quat().tolist(),
                "matterport": {
                    "scanIndex": scan_offset + scan_index,
                    "sourceScanIndex": scan_index,
                    "sourcePart": source_part,
                    "guid": header.guid,
                    "sourceTranslation": list(map(float, header.translation)),
                    "sourceRotation": list(map(float, header.rotation)),
                },
            }
        )
        manifest["groups"][uuid] = {
            "associatedData3DGuid": header.guid,
            "sourceFaces": records,
            "sourceSeamErrors": measure_seams(source_photos),
        }
        print(f"images {scan_index + 1}/{len(headers)}: calibrated 6 faces", flush=True)
    return nodes, manifest


def export_validated_glb(mesh: o3d.geometry.TriangleMesh, out_path: Path) -> None:
    vertices = np.asarray(mesh.vertices)
    triangles = np.asarray(mesh.triangles)
    vertex_normals = (
        np.asarray(mesh.vertex_normals) if mesh.has_vertex_normals() else None
    )
    vertex_colors = None
    if mesh.has_vertex_colors():
        srgb = np.asarray(mesh.vertex_colors)
        linear = np.where(
            srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4
        )
        vertex_colors = np.clip(linear * 255.0, 0, 255).astype(np.uint8)

    glb_mesh = trimesh.Trimesh(
        vertices=vertices,
        faces=triangles,
        vertex_normals=vertex_normals,
        vertex_colors=vertex_colors,
        process=False,
    )
    glb_mesh.export(out_path)
    validate_glb(out_path)


def validate_glb(out_path: Path) -> tuple[int, int]:
    trimesh_check = trimesh.load(out_path, force="mesh", process=False)
    open3d_check = o3d.io.read_triangle_mesh(str(out_path))
    if len(trimesh_check.faces) == 0 or len(open3d_check.triangles) == 0:
        raise RuntimeError(f"GLB validation failed after export: {out_path}")
    return int(len(trimesh_check.vertices)), int(len(trimesh_check.faces))


def node_navigation_point(node: dict[str, Any]) -> np.ndarray:
    point = node.get("floorPosition") or node["position"]
    return np.array([point["x"], point["y"], point["z"]], dtype=np.float64)


def node_camera_point(node: dict[str, Any]) -> np.ndarray:
    point = node["position"]
    return np.array([point["x"], point["y"], point["z"]], dtype=np.float64)


def infer_navigation_config(nodes: list[dict[str, Any]]) -> dict[str, Any]:
    if len(nodes) < 2:
        return {"mode": "all"}

    points = [node_navigation_point(node) for node in nodes]
    nearest_distances = []
    for index, point in enumerate(points):
        distances = [
            float(np.linalg.norm(point - other))
            for other_index, other in enumerate(points)
            if other_index != index
        ]
        nearest_distances.append(min(distances))

    median_spacing = float(np.median(nearest_distances))
    max_distance = min(8.0, max(2.5, median_spacing * 2.75))
    return {
        "mode": "neighbors",
        "maxDistance": round(max_distance, 3),
        "maxVisible": 8,
        "markerRadius": 0.15,
        "minVisible": 0,
        "hideActive": True,
    }


def camera_rotation_toward(
    source: dict[str, Any], target: dict[str, Any] | None
) -> dict[str, float]:
    if not target:
        return {"azimuth": 0, "polar": 0}

    source_position = node_camera_point(source)
    target_position = node_camera_point(target)
    direction = target_position - source_position
    length = float(np.linalg.norm(direction))
    if length <= 1e-6:
        return {"azimuth": 0, "polar": 0}

    direction = direction / length
    azimuth = math.degrees(math.atan2(-direction[0], -direction[2]))
    polar = max(
        -28.0,
        min(18.0, math.degrees(math.asin(max(-1.0, min(1.0, float(direction[1])))))),
    )
    return {"azimuth": round(azimuth, 3), "polar": round(polar, 3)}


def preferred_view_target(
    nodes: list[dict[str, Any]], index: int, navigation_config: dict[str, Any]
) -> dict[str, Any] | None:
    if len(nodes) < 2:
        return None

    source = nodes[index]
    source_position = node_navigation_point(source)
    max_distance = float(navigation_config.get("maxDistance", math.inf))

    if index + 1 < len(nodes):
        next_node = nodes[index + 1]
        if (
            float(np.linalg.norm(node_navigation_point(next_node) - source_position))
            <= max_distance
        ):
            return next_node

    neighbors = [
        (float(np.linalg.norm(node_navigation_point(node) - source_position)), node)
        for node_index, node in enumerate(nodes)
        if node_index != index
    ]
    neighbors.sort(key=lambda item: item[0])
    return neighbors[0][1] if neighbors else None


def initial_explore_node(nodes):
    """Start in the largest reachable area, preserving source order within it."""
    if not nodes:
        return None
    remaining = {node['uuid'] for node in nodes}
    adjacency = {node['uuid']: set(node.get('neighbors', [])) & remaining for node in nodes}
    for origin, targets in list(adjacency.items()):
        for target in list(targets):
            adjacency[target].add(origin)
    components = []
    for node in nodes:
        if node['uuid'] not in remaining:
            continue
        component, queue = set(), [node['uuid']]
        remaining.remove(node['uuid'])
        while queue:
            current = queue.pop()
            component.add(current)
            found = adjacency[current] & remaining
            remaining.difference_update(found)
            queue.extend(found)
        components.append(component)
    largest = max(components, key=len)
    candidates = [node for node in nodes if node['uuid'] in largest and node.get('neighbors') and not node.get('floorUnobserved')]
    return next((node for node in candidates if len(node['neighbors']) >= 2), candidates[0] if candidates else nodes[0])


def build_bootstrap(
    slug: str, title: str, dataset_url: str, nodes: list[dict[str, Any]], mesh_url: str
) -> dict[str, Any]:
    navigation_config = infer_navigation_config(nodes)
    initial = initial_explore_node(nodes)
    tourpoints = []
    for index, node in enumerate(nodes):
        rotation = camera_rotation_toward(
            node, preferred_view_target(nodes, index, navigation_config)
        )
        tourpoints.append(
            {
                "id": f"{node['uuid']}-tourpoint",
                "nodeUUID": node["uuid"],
                "targetType": "NODE",
                "viewMode": "FPV",
                "rotation": rotation,
                "zoom": 0,
                "text": title if index == 0 else "",
                "files": [],
                "models": ["matterport-mesh"],
                "annotations": [],
                "sounds": [],
            }
        )

    return {
        "space": {
            "id": slug,
            "title": title,
            "type": "spaces",
            "version": None,
            "mesh": mesh_url,
            "space_custom": "matterport-e57",
            "space_data": {
                "title": title,
                "initialNode": initial["uuid"] if initial else None,
                "initialRotation": next((point['rotation'] for point in tourpoints if point['nodeUUID'] == initial['uuid']),
                                        {"azimuth": 0, "polar": 0}) if initial else {"azimuth": 0, "polar": 0},
                "nodes": nodes,
                "navigation": navigation_config,
                "navigationTransition": {
                    "enabled": True,
                    "meshIds": ["matterport-mesh"],
                    "opacity": 1,
                    "meshFadeMs": 900,
                    "navigationMs": 1100,
                    "cubeRenderTargetSize": 1024,
                },
                "sceneSettings": {
                    "nodes": {
                        "scale": 1,
                        "offsetPosition": {"x": 0, "y": 0, "z": 0},
                        "offsetRotation": {"x": 0, "y": 0, "z": 0},
                    },
                    "model": {
                        "scale": 1,
                        "offsetPosition": {"x": 0, "y": 0, "z": 0},
                        "offsetRotation": {"x": 0, "y": 0, "z": 0},
                    },
                },
            },
        },
        "tour": {
            "id": f"{slug}-tour",
            "title": title,
            "tour_data": {
                "mode": "explore",
                "defaultShowText": False,
                "sceneGraph": [
                    {
                        "id": "matterport-mesh",
                        "type": "model",
                        "file": mesh_url,
                        "visible": True,
                        "persistent": True,
                        "raycast": True,
                        "fpvOpacity": 0,
                        "orbitOpacity": 1,
                        "debugOpacity": 0.28,
                        "transitionMesh": True,
                        "transitionOpacity": 1,
                        "transitionFadeMs": 900,
                        "transitionTexture": "cube-render-target",
                        "wireframeInDebug": True,
                        "unlit": True,
                        "position": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "scale": 1,
                    }
                ],
                "spaces": [
                    {
                        "id": slug,
                        "title": title,
                        "type": "spaces",
                        "tourpoints": tourpoints,
                    }
                ],
            },
        },
        "ui": {
            "titlePart1": "Explore",
            "titlePart2": title,
            "subtitle": "Step inside. Look around. Explore at your own pace.",
            "loadingImage": f"{dataset_url}/preview.jpg",
            "enterButtonText": "Start",
            "exploreButtonText": "Free Explore",
            "loadingText": "Loading",
            "nextButtonText": "Next",
            "previousButtonText": "Previous",
            "continueExploringButtonText": "Continue Exploring",
        },
    }


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    args = parse_args()
    source = args.e57.expanduser().resolve()
    if not source.is_file():
        raise ValueError(f"Source not found: {source}")
    if source.suffix.lower() not in [".e57", ".zip"]:
        raise ValueError("Provide a complete .e57 or .zip file")
    inferred = re.sub(r"^mp_e57_", "", source.stem)
    inferred = re.sub(r"_[A-Za-z0-9]{11}$", "", inferred)
    args.title = args.title or inferred.replace("-", " ").replace("_", " ")
    args.slug = args.slug or re.sub(r"[^a-z0-9]+", "-", inferred.lower()).strip("-")
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", args.slug):
        raise ValueError("Slug must contain lowercase letters, digits and hyphens")
    if (
        args.target_triangles < 1000
        or args.voxel_size <= 0
        or not 256 <= args.face_size <= 8192
        or not 128 <= args.depth_size <= 2048
        or not 512 <= args.atlas_size <= 8192
    ):
        raise ValueError("Invalid mesh/image resolution")
    processed = (args.processed_root / args.slug).resolve()
    processed.mkdir(parents=True, exist_ok=True)
    extraction_directory = (args.extraction_root / args.slug).resolve() if args.extraction_root else None
    sources = ExportSources(source, processed, args.discard_extracted_source, cache_directory=extraction_directory)
    if args.buffer_part_images and (source.suffix.lower() != '.zip' or not args.discard_extracted_source):
        raise ValueError('--buffer-part-images requires a ZIP and --discard-extracted-source')
    from image_buffer import ImageBuffer
    image_buffer = ImageBuffer() if args.buffer_part_images else None
    if args.resume_geometry and (args.skip_images or args.skip_mesh):
        raise ValueError('--resume-geometry cannot be combined with reuse flags')
    if len(sources.entries) > 1 and (args.skip_images or args.skip_mesh):
        raise ValueError("Multi-part exports require a full import; reuse flags cannot certify partial captures")
    parent = (args.public_root / "datasets" / "matterport").resolve()
    final = parent / args.slug
    staging = parent / f".{args.slug}.building"
    staging.mkdir(parents=True, exist_ok=True)
    dataset_url = f"{args.dataset_prefix.rstrip('/')}/{args.slug}"
    mesh_path = staging / "mesh" / f"{args.slug}-50k.glb"
    mesh_path.parent.mkdir(parents=True, exist_ok=True)
    nodes, source_checks, seen_guids = [], [], set()
    staged_identity = None
    image_manifest = {"images2D": 0, "orientationMethod": "calibrated-image-poses-v2", "groups": {}}
    fusion = None if args.skip_mesh else Fusion(staging, args)
    if fusion is not None:
        fusion.image_buffer = image_buffer
    if args.resume_geometry:
        from checkpoint import load_inputs
        saved, surface = load_inputs(processed / 'geometry-checkpoint', source, args)
        nodes, image_manifest = saved['nodes'], saved['imageManifest']
        source_checks, sources.records = saved['sourceChecks'], saved['sourceParts']
        if (staging / 'manifest.json').is_file():
            candidate = json.loads((staging / 'manifest.json').read_text())
            if candidate.get('sourceSha256') == source_digest(sources.records):
                staged_identity = candidate
        fusion.reports = surface['reports']
        fusion.sampled = [np.load(processed / 'geometry-checkpoint/samples.npy', allow_pickle=False)]
    from validate import validate_source_nodes
    for e57_path, part in ([] if args.resume_geometry else sources):
        e57 = pye57.E57(str(e57_path))
        try:
            headers = [e57.get_header(i) for i in range(e57.scan_count)]
            if not headers:
                raise ValueError("No scans in E57 part")
            if any(header.guid in seen_guids for header in headers) or len({header.guid for header in headers}) != len(headers):
                raise ValueError("Duplicate scan GUID across source parts; cannot silently duplicate capture coverage")
            seen_guids.update(header.guid for header in headers)
            if len(sources.entries) == 1 and not final.exists():
                existing = matching_capture(parent, seen_guids)
                if existing:
                    args.slug = existing['slug']
                    print(f"Keeping existing capture identity and storage slug: {args.slug}", flush=True)
                    processed = (args.processed_root / args.slug).resolve()
                    processed.mkdir(parents=True, exist_ok=True)
                    final, staging = parent / args.slug, parent / f'.{args.slug}.building'
                    dataset_url = f"{args.dataset_prefix.rstrip('/')}/{args.slug}"
                    mesh_path = staging / 'mesh' / f'{args.slug}-50k.glb'
                    mesh_path.parent.mkdir(parents=True, exist_ok=True)
                    if fusion is not None:
                        fusion.dataset_dir = staging
            part.update(scanCount=len(headers), scanOffset=len(nodes))
            if args.skip_images:
                candidates = [(folder, json.loads((folder / 'manifest.json').read_text()))
                              for folder in [final, staging] if (folder / 'manifest.json').is_file()]
                reusable = [(folder, data) for folder, data in candidates
                            if data.get('sourceSha256') == part['sha256'] and data.get('schema') == 'sphr-matterport-e57-v2']
                if not reusable:
                    raise ValueError("--skip-images requires a matching, calibrated v2 package")
                reuse, previous = reusable[0]
                if reuse != staging:
                    shutil.copytree(reuse / "faces", staging / "faces", dirs_exist_ok=True)
                else:
                    staged_identity = previous
                part_nodes = json.loads((reuse / "bootstrap.json").read_text())["space"]["space_data"]["nodes"]
                part_images = previous["imageManifest"]
            else:
                part_nodes, part_images = extract_images(e57, staging, dataset_url, headers, args.face_size, len(nodes), part['part'], image_buffer)
        finally:
            e57.close()
        image_manifest['images2D'] += part_images['images2D']
        image_manifest['groups'].update(part_images['groups'])
        if fusion is not None:
            fusion.integrate(e57_path, part_nodes)
        source_checks.append(validate_source_nodes(e57_path, part_nodes, part['sha256']))
        nodes.extend(part_nodes)
        sources.release_verified(e57_path, source_checks[-1])
        if image_buffer is not None:
            image_buffer.flush()
    source_hash = source_digest(sources.records)
    if args.skip_mesh:
        previous = json.loads((final / "manifest.json").read_text())
        if (
            previous.get("sourceSha256") != source_hash
            or previous.get("schema") != "sphr-matterport-e57-v2"
        ):
            raise ValueError("--skip-mesh requires matching calibrated v2 package")
        shutil.copy2(final / "mesh" / mesh_path.name, mesh_path)
        old_nodes = json.loads((final / "bootstrap.json").read_text())["space"][
            "space_data"
        ]["nodes"]
        for n, old in zip(nodes, old_nodes):
            for key in ["floorPosition", "floorEstimate", "neighbors"]:
                n[key] = old[key]
            n['floorUnobserved'] = old.get('floorUnobserved', False)
        shutil.copy2(final / "quality.json", staging / "quality.json")
        mesh_manifest = previous["mesh"]
        if (final / "mesh" / "atlas.jpg").exists():
            shutil.copy2(final / "mesh" / "atlas.jpg", staging / "mesh" / "atlas.jpg")
        validate_glb(mesh_path)
    elif args.mesh_method == "tsdf":
        if not args.resume_geometry:
            from checkpoint import save_inputs
            save_inputs(processed / 'geometry-checkpoint', source, args, nodes, image_manifest, sources.records, source_checks)
        mesh_manifest = fusion.finish(nodes, mesh_path, export_validated_glb)
    else:
        raise ValueError(
            "The calibrated v2 pipeline requires --mesh-method tsdf; legacy methods cannot certify visibility and registration"
        )
    if not mesh_manifest.get("texture"):
        mesh_manifest["texture"] = texture_mesh(
            mesh_path, staging, nodes, args.atlas_size
        )
        vertices, triangles = validate_glb(mesh_path)
        mesh_manifest.update(
            vertices=vertices, triangles=triangles, bytes=mesh_path.stat().st_size
        )
    mesh_manifest["sha256"] = sha256_file(mesh_path)
    # Face into the locally connected scan area at eye level. This also avoids
    # almost-duplicate revisit scans making the initial camera point at the floor.
    for node in nodes:
        neighbors = [n for n in nodes if n["uuid"] in node["neighbors"]]
        same_level = [
            n
            for n in neighbors
            if abs(n["position"]["y"] - node["position"]["y"]) < 0.6
        ]
        target = None
        if same_level:
            center = np.mean([node_camera_point(n) for n in same_level], axis=0)
            if np.linalg.norm((center - node_camera_point(node))[[0, 2]]) > 0.25:
                target = {"position": dict(zip("xyz", center.tolist()))}
        node["initialRotation"] = camera_rotation_toward(
            node, target or (neighbors[0] if neighbors else None)
        )
    bootstrap = build_bootstrap(
        args.slug,
        args.title,
        dataset_url,
        nodes,
        f"{dataset_url}/mesh/{mesh_path.name}",
    )
    for point, node in zip(
        bootstrap["tour"]["tour_data"]["spaces"][0]["tourpoints"], nodes
    ):
        point["rotation"] = node["initialRotation"]
        point["text"] = ""
        point["secondaryText"] = None
    initial = initial_explore_node(nodes)
    bootstrap["space"]["space_data"]["initialRotation"] = initial["initialRotation"]
    bootstrap["space"]["thumbnail"] = f"{dataset_url}/preview.jpg"
    azimuth = math.radians(initial["initialRotation"]["azimuth"])
    direction = np.array([-math.sin(azimuth), 0, -math.cos(azimuth)])
    local_direction = Rotation.from_quat(initial["quaternion"]).inv().apply(direction)
    cover_face = 1 + int(np.argmax(CENTERS[1:5] @ local_direction))
    with Image.open(
        staging / "faces" / initial["uuid"] / f"face{cover_face}.jpg"
    ) as image:
        image.resize((960, 960), Image.Resampling.LANCZOS).save(
            staging / "preview.jpg", quality=90
        )
    manifest = {
        "schema": "sphr-matterport-e57-v2",
        "slug": args.slug,
        "title": args.title,
        "source": str(source),
        "sourceSha256": source_hash,
        "scanCount": len(nodes),
        "sourceParts": sources.records,
        "nodeCount": len(nodes),
        "datasetUrl": dataset_url,
        "bootstrapUrl": f"{dataset_url}/bootstrap.json",
        "coordinateConversion": "meters; three = [e57.x, e57.z, -e57.y]; quaternion maps canonical cube directions to world",
        "imageManifest": image_manifest,
        "mesh": mesh_manifest,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    previous_manifest = json.loads((final / "manifest.json").read_text()) if (final / "manifest.json").exists() else staged_identity
    manifest.update(scene_identity(manifest, previous_manifest))
    for name, data in [("bootstrap.json", bootstrap), ("manifest.json", manifest)]:
        (staging / name).write_text(json.dumps(data, indent=2) + "\n")
    # Publish only a fully validated package; failed runs leave the previous import usable.
    from validate import validate_package

    result = validate_package(staging, source_checks=source_checks)
    (staging / "validation.json").write_text(json.dumps(result, indent=2) + "\n")
    backup = parent / f".{args.slug}.previous"
    if backup.exists():
        shutil.rmtree(backup)
    if final.exists():
        final.rename(backup)
    try:
        staging.rename(final)
    except Exception:
        if backup.exists():
            backup.rename(final)
        raise
    (processed / "nodes.json").write_text(json.dumps(nodes, indent=2) + "\n")
    (processed / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    write_matterport_index(parent)
    checkpoint = processed / 'geometry-checkpoint'
    if checkpoint.is_dir():
        shutil.rmtree(checkpoint)
    print(
        json.dumps(
            {
                "dataset": str(final),
                "bootstrap": manifest["bootstrapUrl"],
                "sceneUrl": manifest["scenePath"],
                "scans": len(nodes),
                "faces": len(nodes) * 6,
                "mesh": mesh_manifest,
                "validation": result,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
