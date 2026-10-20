"""Convert a Matterport Capture app job folder into a measured, source-bound SPHR scene.

The Capture app (on an iPad or iPhone paired with a Matterport camera) keeps what it measured in
<job>/SweepProcessorData/: manifest.mfst with every sweep's alignment pose, a 512 px cube of each
panorama (<sweep>_512_00N.jpg), the depth camera's point cloud (<sweep-uuid>_sweep_cloud.pb) and a
coarse per-sweep mesh (<sweep>.dam). Matterport makes full-resolution panoramas later in its cloud; a
job folder has only these.

This importer places each aligned sweep at its measured pose with its six cube faces, fuses the
sweeps' point clouds into one surface, textures it from the faces, finds the floor under each camera
and links sweeps that see each other. Sweeps the app could not align have no pose; they are left out
and listed in the manifest. It never presents the job folder as an E57 export.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import struct
import uuid

os.environ.setdefault("OMP_NUM_THREADS", "1")

import numpy as np
import open3d as o3d
from PIL import Image
from scipy.spatial import cKDTree
from scipy.spatial.transform import Rotation

from catalog import atomic_json, scene_identity, write_matterport_index
from geometry import C, CENTERS, RIGHTS, UPS, estimate_floor
from reconstruct import build_graph, refine_floors
from reduction import clean, reduce_mesh
from seams import measure_seams
from texture import texture_mesh
from web_archive import fields, graph_components, load_dam

SCHEMA = "sphr-matterport-capture-v1"
# Matterport's cube faces in a sweep's own frame (meters, z up): forward, right and image-up axes. Measured
# from the per-sweep DAM texture coordinates (which count rows up from the bottom) and confirmed by colour
# agreement between neighbouring sweeps; layout_error() re-measures every sweep before its faces are used.
MATTERPORT_FACES = np.array([
    [(0, 0, 1), (0, -1, 0), (-1, 0, 0)],
    [(1, 0, 0), (0, -1, 0), (0, 0, 1)],
    [(0, -1, 0), (-1, 0, 0), (0, 0, 1)],
    [(-1, 0, 0), (0, 1, 0), (0, 0, 1)],
    [(0, 1, 0), (1, 0, 0), (0, 0, 1)],
    [(0, 0, -1), (0, -1, 0), (1, 0, 0)],
], dtype=float)
MAX_LAYOUT_ERROR = 0.03  # of a face width; measured sweeps sit near 0.005


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def find_job(root):
    """The one job folder in an extracted upload: the folder holding SweepProcessorData/manifest.mfst."""
    root = root.resolve()
    jobs = [path.parent.parent for path in root.glob("**/SweepProcessorData/manifest.mfst")
            if len(path.relative_to(root).parts) <= 6]
    if len(jobs) != 1:
        raise ValueError(f"Expected one Matterport Capture job folder, found {len(jobs)}")
    return jobs[0]


def source_file(job, name):
    """A regular file inside the job's SweepProcessorData folder; uploads are untrusted, so links never count."""
    if Path(name).name != name:
        raise ValueError("Invalid source file name")
    path = job / "SweepProcessorData" / name
    if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(job.resolve()):
        raise FileNotFoundError(f"Missing source file: {name}")
    return path


def uuid_hex(value):
    if len(value) != 16:
        raise ValueError("Invalid sweep identifier")
    return uuid.UUID(bytes=bytes(value)).hex


def read_manifest(path):
    """Aligned sweeps in capture order with their poses, the sweeps the app could not align, and the camera."""
    aligned, unaligned, camera = [], [], None
    for number, wire, record in fields(path.read_bytes()):
        if number not in (1, 7) or wire != 2:
            continue
        values = {}
        for field, kind, value in fields(record):
            values.setdefault(field, (kind, value))
        text = lambda field: values[field][1].decode("utf-8", "replace") if values.get(field, (0,))[0] == 2 else ""
        sweep = {"uuid": uuid_hex(values[1][1]), "status": text(14),
                 "parent": uuid_hex(values[2][1]) if values.get(2, (0,))[0] == 2 else None}
        camera = camera or text(20) or None
        if values.get(4, (0,))[0] == 1:
            sweep["captured"] = datetime.fromtimestamp(struct.unpack("<d", values[4][1])[0], timezone.utc).isoformat()
        if number == 1 and values.get(3, (0,))[0] == 2:
            pose = [struct.unpack("<f", value)[0] for field, kind, value in fields(values[3][1]) if field == 1 and kind == 5]
            if len(pose) != 7 or not np.isfinite(pose).all() or abs(np.linalg.norm(pose[:4]) - 1) > 1e-3:
                raise ValueError(f"Invalid pose for sweep {sweep['uuid']}")
            # The rotation (x, y, z, w) and translation take points from the sweep's frame to the job's frame.
            sweep["rotation"], sweep["translation"] = pose[:4], pose[4:]
            aligned.append(sweep)
        else:
            unaligned.append(sweep)
    if not aligned:
        raise ValueError("The job has no aligned sweeps")
    return aligned, unaligned, camera


def read_cloud(path):
    """The depth camera's points and normals for one sweep, in the sweep's frame."""
    rows = []
    for number, wire, record in fields(path.read_bytes()):
        if number != 7 or wire != 2:
            continue
        for field, kind, value in fields(record):
            if field == 5 and kind == 2 and len(value) >= 24:
                rows.append(np.frombuffer(value[:24], dtype="<f4"))
    data = np.array(rows, dtype=float).reshape(-1, 6)
    data = data[np.isfinite(data).all(1) & (np.linalg.norm(data[:, :3], axis=1) > 0.05)]
    if len(data) < 1000:
        raise ValueError(f"{path.name} holds too few depth points")
    return data[:, :3], data[:, 3:]


def layout_error(dam_path):
    """How far the sweep's own DAM texture coordinates fall from MATTERPORT_FACES, in face widths."""
    errors = []
    for chunk in load_dam(dam_path):
        match = re.search(r"_(\d{3})\.jpg$", chunk["material"])
        if not match or int(match[1]) > 5:
            raise ValueError("Unexpected DAM material")
        forward, right, up = MATTERPORT_FACES[int(match[1])]
        vertices = chunk["vertices"]
        depth = vertices @ forward
        keep = depth > 0.05
        if keep.sum() < 20:
            continue
        predicted = 0.5 + 0.5 * np.column_stack([vertices[keep] @ right, vertices[keep] @ up]) / depth[keep, None]
        errors.append(float(np.median(np.abs(predicted - chunk["uv"][keep]))))
    if not errors:
        raise ValueError(f"{dam_path.name} has no usable texture coordinates")
    return max(errors)


def face_file(job, sweep, face):
    """A sweep's Matterport face: the 512 px set, or the app's skybox copy of the same image."""
    for name in (f"{sweep['uuid']}_512_00{face}.jpg", f"{sweep['uuid']}_skybox{face}.jpg"):
        try:
            return source_file(job, name)
        except FileNotFoundError:
            continue
    raise FileNotFoundError(f"Sweep {sweep['uuid']} has no cube face {face}")


def load_faces(job, sweep):
    """The sweep's six Matterport faces as RGB arrays, with their source files."""
    images, paths = [], []
    for face in range(6):
        path = face_file(job, sweep, face)
        with Image.open(path) as image:
            image.verify()
        with Image.open(path) as image:
            pixels = np.asarray(image.convert("RGB"))
        if pixels.shape[0] != pixels.shape[1] or (images and pixels.shape != images[0].shape):
            raise ValueError(f"Sweep {sweep['uuid']} has faces of different sizes")
        images.append(pixels)
        paths.append(path)
    return images, paths


def sphr_face(images, face):
    """SPHR cube face `face` cut from a sweep's Matterport faces: the same pixels, turned to SPHR's layout.

    SPHR's canonical cube is the sweep frame seen through C, so each SPHR face is one Matterport face
    turned by a multiple of 90 degrees and every output pixel is one source pixel.
    """
    center, right, up = (C.T @ axis for axis in (CENTERS[face], RIGHTS[face], UPS[face]))
    source = int(np.flatnonzero(np.all(np.isclose(MATTERPORT_FACES[:, 0], center), axis=1))[0])
    _, source_right, source_up = MATTERPORT_FACES[source]
    size = images[source].shape[0]
    a, b = np.meshgrid(2 * (np.arange(size) + 0.5) / size - 1, 1 - 2 * (np.arange(size) + 0.5) / size)
    along, upward = a * (right @ source_right) + b * (up @ source_right), a * (right @ source_up) + b * (up @ source_up)
    x = np.rint((along + 1) / 2 * size - 0.5).astype(int)
    y = np.rint((1 - upward) / 2 * size - 0.5).astype(int)
    return source, images[source][y, x]


def node_pose(sweep):
    """Camera position and quaternion (x, y, z, w) in the viewer's frame: three = C @ job frame."""
    rotation = Rotation.from_quat(sweep["rotation"]).as_matrix()
    return C @ np.asarray(sweep["translation"]), Rotation.from_matrix(C @ rotation @ C.T).as_quat()


def fused_points(job, sweeps):
    """Every sweep's depth points and normals in the viewer's frame, normals turned toward their camera, and the
    sweeps without usable depth (they are still placed and only add no surface)."""
    points, normals, missing = [], [], []
    for sweep in sweeps:
        try:
            local, local_normals = read_cloud(source_file(job, f"{uuid.UUID(hex=sweep['uuid'])}_sweep_cloud.pb"))
        except (FileNotFoundError, ValueError):
            missing.append(sweep["uuid"])
            continue
        rotation = Rotation.from_quat(sweep["rotation"]).as_matrix()
        world = (local @ rotation.T + sweep["translation"]) @ C.T
        turned = local_normals @ rotation.T @ C.T
        camera, _ = node_pose(sweep)
        turned[np.sum(turned * (camera - world), axis=1) < 0] *= -1
        points.append(world)
        normals.append(turned)
    if sum(len(part) for part in points) < 20000:
        raise ValueError("The job has no usable depth point clouds to measure a surface from; build a panorama tour instead")
    return np.concatenate(points), np.concatenate(normals), missing


def fuse_surface(points, normals, depth):
    """A Poisson surface through the measured points, trimmed back to where points were measured."""
    cloud = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(points))
    cloud.normals = o3d.utility.Vector3dVector(normals)
    mesh, density = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(cloud, depth=depth, scale=1.1)
    density = np.asarray(density)
    mesh.remove_vertices_by_mask(density < np.quantile(density, 0.02))
    # Poisson also closes open space; keep only surface within reach of a measured point.
    distance, _ = cKDTree(points).query(np.asarray(mesh.vertices), distance_upper_bound=0.25)
    mesh.remove_vertices_by_mask(~np.isfinite(distance))
    mesh = clean(mesh)
    if not len(mesh.triangles):
        raise ValueError("The fused surface is empty")
    mesh.compute_vertex_normals()
    return mesh


def vertex_colors(mesh, nodes, stage):
    """Each vertex coloured from its nearest camera, for parts of the atlas no camera sees."""
    vertices = np.asarray(mesh.vertices)
    cameras = np.array([[node["position"][k] for k in "xyz"] for node in nodes])
    nearest = cKDTree(cameras).query(vertices)[1]
    colors = np.zeros((len(vertices), 3))
    for index, node in enumerate(nodes):
        selected = np.flatnonzero(nearest == index)
        if not len(selected):
            continue
        local = (vertices[selected] - cameras[index]) @ Rotation.from_quat(node["quaternion"]).as_matrix()
        face_id = np.argmax(local @ CENTERS.T, axis=1)
        for face in range(6):
            chosen = face_id == face
            if not chosen.any():
                continue
            with Image.open(stage / "faces" / node["uuid"] / f"face{face}.jpg") as photo:
                pixels = np.asarray(photo.convert("RGB"), dtype=float) / 255
            direction = local[chosen]
            depth = direction @ CENTERS[face]
            u = np.clip(((direction @ RIGHTS[face] / depth) * 0.5 + 0.5) * pixels.shape[1], 0, pixels.shape[1] - 1).astype(int)
            v = np.clip(((-direction @ UPS[face] / depth) * 0.5 + 0.5) * pixels.shape[0], 0, pixels.shape[0] - 1).astype(int)
            colors[selected[chosen]] = pixels[v, u]
    mesh.vertex_colors = o3d.utility.Vector3dVector(colors)


def build_nodes(job, sweeps, stage, dataset_url):
    nodes, groups, layout = [], {}, []
    for index, sweep in enumerate(sweeps):
        # Each sweep with a DAM checks the cube layout against its own texture coordinates.
        try:
            error = layout_error(source_file(job, f"{sweep['uuid']}.dam"))
        except FileNotFoundError:
            error = None
        if error is not None and error > MAX_LAYOUT_ERROR:
            raise ValueError(f"Sweep {sweep['uuid']} does not use the known cube layout (error {error:.3f})")
        if error is not None:
            layout.append(error)
        images, paths = load_faces(job, sweep)
        name = f"scan-{index:03d}"
        folder = stage / "faces" / name
        folder.mkdir(parents=True)
        faces, records, photos = [], [], []
        for face in range(6):
            source, pixels = sphr_face(images, face)
            target = folder / f"face{face}.jpg"
            if np.array_equal(pixels, images[source]):
                shutil.copyfile(paths[source], target)
            else:
                Image.fromarray(pixels).save(target, quality=95, subsampling=0)
            faces.append(f"{dataset_url}/faces/{name}/face{face}.jpg")
            records.append({"sphrFace": face, "sourceName": paths[source].name, "sourceFace": source,
                            "size": [pixels.shape[1], pixels.shape[0]], "sha256": digest(target)})
            photos.append(np.asarray(Image.fromarray(pixels).resize((256, 256)), dtype=float) / 255)
        position, quaternion = node_pose(sweep)
        sweep_uuid = str(uuid.UUID(hex=sweep["uuid"]))
        nodes.append({"uuid": name, "label": f"Location {index + 1}", "faces": faces,
                      "position": dict(zip("xyz", position.tolist())), "quaternion": quaternion.tolist(),
                      "resolution": str(images[0].shape[0]), "sourceDimensions": [images[0].shape[1], images[0].shape[0]],
                      "matterport": {"sweepUuid": sweep_uuid, "captured": sweep.get("captured"), "alignment": sweep["status"],
                                     "sourceTranslation": list(sweep["translation"]), "sourceRotationXyzw": list(sweep["rotation"])}})
        groups[name] = {"associatedData3DGuid": sweep_uuid, "sourceFaces": records, "layoutError": error,
                        "sourceSeamErrors": measure_seams(photos)}
    if not layout:
        raise ValueError("No sweep has a DAM mesh to check the cube layout against")
    return nodes, groups, layout


def steady_floors(nodes, points, normals):
    """A tripod keeps one height through a job: re-find floors that sit far from the job's usual camera height.

    A local plane beside the tripod can be a table or pallet top. The floor at the usual height replaces it only
    where measured, upward-facing points support it around the camera.
    """
    heights = [node["position"]["y"] - node["floorPosition"]["y"] for node in nodes if node.get("floorPosition")]
    if len(heights) < 5:
        return []
    usual = float(np.median(heights))
    upward = points[normals[:, 1] > 0.8]
    corrected = []
    for node in nodes:
        floor = node.get("floorPosition")
        if floor and abs(node["position"]["y"] - floor["y"] - usual) <= 0.25:
            continue
        camera = np.array([node["position"][k] for k in "xyz"])
        near = upward[(np.linalg.norm(upward[:, [0, 2]] - camera[[0, 2]], axis=1) < 3) & (np.abs(upward[:, 1] - (camera[1] - usual)) < 0.08)]
        if len(near) < 200:
            continue
        level = float(np.median(near[:, 1]))
        node["floorEstimate"] = {"method": "job-camera-height", "cameraHeight": float(camera[1] - level), "jobCameraHeight": usual,
                                 "points": len(near), "replaced": node.get("floorEstimate")}
        node["floorPosition"] = {**node["position"], "y": level + 0.025}
        node.pop("floorUnobserved", None)
        corrected.append(node["uuid"])
    return corrected


def add_alignment_links(nodes, sweeps):
    """The app aligned each sweep to one it overlapped. Keep those source links, as web imports keep source edges."""
    by_sweep = {sweep["uuid"]: node for sweep, node in zip(sweeps, nodes)}
    added = []
    for sweep, node in zip(sweeps, nodes):
        parent = by_sweep.get(sweep.get("parent"))
        if parent is None:
            continue
        for a, b in ((node, parent), (parent, node)):
            if b["uuid"] not in a["neighbors"]:
                a["neighbors"].append(b["uuid"])
                added.append([a["uuid"], b["uuid"]])
    return added


def place_floors(nodes, points, normals, full_mesh, scene):
    reports = []
    for node in nodes:
        camera = np.array([node["position"][k] for k in "xyz"])
        try:
            level, estimate = estimate_floor(points, camera)
            node["floorPosition"] = {**node["position"], "y": level + 0.025}
        except ValueError as error:
            node["floorPosition"] = None
            estimate = {"method": "unobserved", "reason": str(error)}
        node["floorEstimate"] = estimate
        reports.append({"floor": estimate})
    refine_floors(nodes, reports, full_mesh, scene)
    return reports, steady_floors(nodes, points, normals)


def convert(job_root, slug, title, public_root, poisson_depth=10, target_triangles=50000, atlas_size=4096):
    # The bootstrap and E57 helpers already shape the viewer's spaces; reuse them rather than fork the runtime.
    from converter import (build_bootstrap, camera_rotation_toward, export_validated_glb, initial_explore_node, node_camera_point,
                           node_navigation_point, validate_glb)

    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", slug):
        raise ValueError("Invalid storage slug")
    job = find_job(job_root)
    manifest_path = source_file(job, "manifest.mfst")
    sweeps, unaligned, camera_model = read_manifest(manifest_path)
    directory = public_root / "datasets/matterport"
    directory.mkdir(parents=True, exist_ok=True)
    final = directory / slug
    stage = directory / f".{slug}.capture-staging"
    stage.mkdir()  # never share or overwrite an in-progress staging directory
    dataset_url = f"/datasets/matterport/{slug}"
    nodes, groups, layout = build_nodes(job, sweeps, stage, dataset_url)
    print(f"capture: {len(nodes)} aligned sweeps placed, {len(unaligned)} unaligned left out; worst cube layout error {max(layout):.4f}", flush=True)

    points, normals, without_depth = fused_points(job, sweeps)
    full_mesh = fuse_surface(points, normals, poisson_depth)
    print(f"capture: fused {len(points):,} depth points into {len(full_mesh.triangles):,} triangles"
          f"{f'; {len(without_depth)} sweeps had no depth' if without_depth else ''}", flush=True)
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(full_mesh))
    floor_reports, steadied = place_floors(nodes, points, normals, full_mesh, scene)
    graph = build_graph(nodes, scene)
    visible = graph["directedEdges"]
    graph["alignmentLinks"] = add_alignment_links(nodes, sweeps)
    graph.update(directedEdges=sum(len(node["neighbors"]) for node in nodes), components=graph_components(nodes),
                 isolatedNodes=[node["uuid"] for node in nodes if not node["neighbors"]])
    print(f"capture: {visible} links by line of sight and {len(graph['alignmentLinks'])} from the app's alignment, "
          f"in {len(graph['components'])} connected areas; {len(steadied)} floors re-found at the job's camera height", flush=True)

    full_triangles = len(full_mesh.triangles)
    mesh, passes = reduce_mesh(full_mesh, target_triangles)
    mesh.compute_vertex_normals()
    vertex_colors(mesh, nodes, stage)
    mesh_path = stage / "mesh" / f"{slug}-50k.glb"
    mesh_path.parent.mkdir(parents=True, exist_ok=True)
    export_validated_glb(mesh, mesh_path)
    texture = texture_mesh(mesh_path, stage, nodes, atlas_size)
    vertices, triangles = validate_glb(mesh_path)
    mesh_record = {"path": f"mesh/{slug}-50k.glb", "triangles": triangles, "vertices": vertices,
                   "bytes": mesh_path.stat().st_size, "sha256": digest(mesh_path), "texture": texture,
                   "source": f"Poisson surface (depth {poisson_depth}) of {len(points):,} measured depth points",
                   "reduction": passes, "fullTriangles": full_triangles}

    # Face into the locally connected area at eye level, as E57 imports do.
    for node in nodes:
        neighbors = [n for n in nodes if n["uuid"] in node["neighbors"]]
        same_level = [n for n in neighbors if abs(n["position"]["y"] - node["position"]["y"]) < 0.6]
        target = None
        if same_level:
            center = np.mean([node_camera_point(n) for n in same_level], axis=0)
            if np.linalg.norm((center - node_camera_point(node))[[0, 2]]) > 0.25:
                target = {"position": dict(zip("xyz", center.tolist()))}
        node["initialRotation"] = camera_rotation_toward(node, target or (neighbors[0] if neighbors else None))
    bootstrap = build_bootstrap(slug, title, dataset_url, nodes, f"{dataset_url}/{mesh_record['path']}")
    bootstrap["space"]["space_custom"] = "matterport-capture"
    # Respect every kept link, including source links longer than the inferred cap (as web imports do).
    navigation = bootstrap["space"]["space_data"]["navigation"]
    by_id = {node["uuid"]: node for node in nodes}
    longest = max((float(np.linalg.norm(node_navigation_point(node) - node_navigation_point(by_id[other])))
                   for node in nodes for other in node["neighbors"]), default=0)
    if navigation.get("mode") == "neighbors":
        navigation["maxDistance"] = round(max(navigation["maxDistance"], longest + 0.1), 3)
    for point, node in zip(bootstrap["tour"]["tour_data"]["spaces"][0]["tourpoints"], nodes):
        point["rotation"] = node["initialRotation"]
        point["text"] = ""
        point["secondaryText"] = None
    initial = initial_explore_node(nodes)
    bootstrap["space"]["space_data"]["initialRotation"] = initial["initialRotation"]
    bootstrap["space"]["thumbnail"] = f"{dataset_url}/preview.jpg"
    azimuth = math.radians(initial["initialRotation"]["azimuth"])
    local_direction = Rotation.from_quat(initial["quaternion"]).inv().apply([-math.sin(azimuth), 0, -math.cos(azimuth)])
    cover_face = 1 + int(np.argmax(CENTERS[1:5] @ local_direction))
    with Image.open(stage / "faces" / initial["uuid"] / f"face{cover_face}.jpg") as image:
        image.resize((960, 960), Image.Resampling.LANCZOS).save(stage / "preview.jpg", quality=90)
    atomic_json(stage / "bootstrap.json", bootstrap)

    sources = [manifest_path] + [Path(job / "SweepProcessorData" / face["sourceName"])
                                 for group in groups.values() for face in group["sourceFaces"]]
    for name in ([f"{uuid.UUID(hex=s['uuid'])}_sweep_cloud.pb" for s in sweeps if s["uuid"] not in without_depth]
                 + [f"{s['uuid']}.dam" for s in sweeps]):
        try:
            sources.append(source_file(job, name))
        except FileNotFoundError:
            pass  # a sweep without a DAM is placed all the same
    source_records = [{"path": str(p.relative_to(job)), "bytes": p.stat().st_size, "sha256": digest(p)} for p in sorted(set(sources))]
    metafile = next((p for p in [job.parent / "metafile.json", job / "metafile.json"] if p.is_file() and not p.is_symlink()), None)
    app = {key: value for key, value in json.loads(metafile.read_text()).items() if key in ("platform", "app_version")} if metafile else {}
    manifest = {"schema": SCHEMA, "slug": slug, "title": title,
                "source": "Matterport Capture app job folder", "captureApp": app, "camera": camera_model,
                "sourceSha256": hashlib.sha256(json.dumps(source_records, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
                "sourceAssets": source_records, "scanCount": len(nodes), "nodeCount": len(nodes),
                "unalignedSweeps": [{"sweepUuid": str(uuid.UUID(hex=s["uuid"])), "status": s["status"]} for s in unaligned],
                "sweepsWithoutDepth": [str(uuid.UUID(hex=h)) for h in without_depth],
                "datasetUrl": dataset_url, "bootstrapUrl": f"{dataset_url}/bootstrap.json",
                "coordinateConversion": "meters; three = C @ Capture job frame (z up); quaternion maps canonical cube directions to world",
                "imageManifest": {"images2D": 6 * len(nodes), "orientationMethod": "matterport-capture-cube-v1",
                                  "maxLayoutError": max(layout), "groups": groups},
                "mesh": mesh_record, "graph": graph,
                "floors": {"measured": sum(1 for node in nodes if node.get("floorPosition")), "unobserved": sum(1 for node in nodes if not node.get("floorPosition")),
                           "reFoundAtJobCameraHeight": steadied},
                "limitations": ["The Capture app keeps 512 px cube faces; Matterport makes full-resolution panoramas in its cloud",
                                "The surface is fused from the depth camera's subsampled per-sweep point clouds",
                                *([f"{len(unaligned)} sweeps the app could not align have no position and are left out"] if unaligned else []),
                                *([f"{len(without_depth)} sweeps had no depth points; they are placed but add nothing to the surface"] if without_depth else [])],
                "createdAt": datetime.now(timezone.utc).isoformat()}
    old = json.loads((final / "manifest.json").read_text()) if (final / "manifest.json").exists() else None
    if old and old.get("schema") not in (None, SCHEMA):
        old = {"sceneId": old.get("sceneId")}  # a reprocessed space keeps its scene ID across importers
    manifest.update(scene_identity(manifest, old))
    atomic_json(stage / "manifest.json", manifest)
    report = validate_package(stage, job)
    atomic_json(stage / "validation.json", report)
    if final.exists():
        final.rename(directory / f".{slug}.previous-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}")
    stage.rename(final)
    write_matterport_index(directory)
    return {"dataset": str(final), "scenePath": manifest["scenePath"], "nodes": len(nodes), "unaligned": len(unaligned),
            "triangles": triangles, "links": graph["directedEdges"], "areas": len(graph["components"]),
            "floorsMeasured": manifest["floors"]["measured"]}


def validate_package(folder, job=None):
    """Checks the package on disk and, given the job folder, that it still matches its sources."""
    manifest = json.loads((folder / "manifest.json").read_text())
    bootstrap = json.loads((folder / "bootstrap.json").read_text())
    if manifest["schema"] != SCHEMA:
        raise ValueError("Not a Matterport Capture package")
    nodes = bootstrap["space"]["space_data"]["nodes"]
    groups = manifest["imageManifest"]["groups"]
    if len(nodes) != manifest["nodeCount"] or {n["uuid"] for n in nodes} != set(groups):
        raise ValueError("Node count/identity mismatch")
    prefix = manifest["datasetUrl"] + "/"
    for node in nodes:
        position = np.array([node["position"][k] for k in "xyz"])
        if len(node["faces"]) != 6 or not np.isfinite(position).all() or abs(np.linalg.norm(node["quaternion"]) - 1) > 1e-6:
            raise ValueError(f"Invalid node {node['uuid']}")
        for face, (url, record) in enumerate(zip(node["faces"], groups[node["uuid"]]["sourceFaces"])):
            path = (folder / url[len(prefix):]).resolve()
            if not url.startswith(prefix) or not path.is_relative_to(folder.resolve()) or record["sphrFace"] != face:
                raise ValueError("Face is not local to the package")
            if digest(path) != record["sha256"]:
                raise ValueError(f"Face changed: {url}")
    mesh_path = folder / manifest["mesh"]["path"]
    if digest(mesh_path) != manifest["mesh"]["sha256"] or not (folder / "mesh/atlas.jpg").is_file():
        raise ValueError("Mesh or atlas missing or changed")
    seams = [float(np.mean(group["sourceSeamErrors"])) for group in groups.values()]
    checked = 0
    if job is not None:
        for record in manifest["sourceAssets"]:
            path = (job / record["path"]).resolve()
            if not path.is_relative_to(job.resolve()) or digest(path) != record["sha256"]:
                raise ValueError("Source binding failed")
        sweeps, _, _ = read_manifest(source_file(job, "manifest.mfst"))
        if len(sweeps) != len(nodes):
            raise ValueError("Package does not hold every aligned sweep")
        for node, sweep in zip(nodes, sweeps):
            position, quaternion = node_pose(sweep)
            if node["matterport"]["sweepUuid"] != str(uuid.UUID(hex=sweep["uuid"])):
                raise ValueError("Sweep order changed")
            if not np.allclose(list(node["position"].values()), position, atol=1e-6):
                raise ValueError("Source position mismatch")
            if (Rotation.from_quat(node["quaternion"]).inv() * Rotation.from_quat(quaternion)).magnitude() > 1e-6:
                raise ValueError("Source orientation mismatch")
            images, _ = load_faces(job, sweep)
            for face in range(6):
                _, expected = sphr_face(images, face)
                with Image.open(folder / "faces" / node["uuid"] / f"face{face}.jpg") as image:
                    actual = np.asarray(image.convert("RGB"), dtype=float)
                if np.mean(np.abs(actual - expected)) > 3:
                    raise ValueError(f"Face {face} of {node['uuid']} does not match its source")
            checked += 1
    return {"schema": "sphr-matterport-capture-validation-v1", "passed": True, "sourceVerified": job is not None,
            "nodes": len(nodes), "faces": 6 * len(nodes), "sourceNodesChecked": checked,
            "triangles": manifest["mesh"]["triangles"], "maxLayoutError": manifest["imageManifest"]["maxLayoutError"],
            "seams": {"mean": float(np.mean(seams)), "max": float(np.max(seams))}, "graphComponents": len(manifest["graph"]["components"]),
            "registration": "Matterport Capture app alignment poses; depth from the camera's per-sweep point clouds"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job", type=Path, help="Extracted upload holding one Capture job folder (…/SweepProcessorData/manifest.mfst)")
    parser.add_argument("--slug")
    parser.add_argument("--title")
    parser.add_argument("--public-root", type=Path, default=Path(__file__).resolve().parents[2] / "public")
    parser.add_argument("--poisson-depth", type=int, default=10)
    parser.add_argument("--target-triangles", type=int, default=50000)
    parser.add_argument("--atlas-size", type=int, default=4096)
    parser.add_argument("--validate", type=Path, help="Validate an existing package; optionally bind --job")
    args = parser.parse_args()
    if args.validate:
        print(json.dumps(validate_package(args.validate.resolve(), find_job(args.job) if args.job else None), indent=2))
    else:
        if not args.job or not args.slug or not args.title:
            parser.error("Conversion requires --job, --slug and --title")
        print(json.dumps(convert(args.job, args.slug, args.title, args.public_root.resolve(),
                                 args.poisson_depth, args.target_triangles, args.atlas_size), indent=2))
