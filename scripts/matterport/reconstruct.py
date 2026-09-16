"""Fuse measured range data, derive floors, and certify point/photo alignment."""

import json
import numpy as np
import open3d as o3d
import pye57
from PIL import Image
from scipy.ndimage import maximum_filter, minimum_filter
from scipy.spatial.transform import Rotation
from geometry import C, CENTERS, RIGHTS, UPS, estimate_floor


def fuse(e57_path, nodes, dataset_dir, out_path, args, export_mesh):
    volume = o3d.pipelines.integration.ScalableTSDFVolume(
        voxel_length=args.voxel_size,
        sdf_trunc=args.voxel_size * 4,
        color_type=o3d.pipelines.integration.TSDFVolumeColorType.RGB8,
        depth_sampling_stride=2,
    )
    size = args.depth_size
    intrinsic = o3d.camera.PinholeCameraIntrinsic(
        size, size, size / 2, size / 2, size / 2 - 0.5, size / 2 - 0.5
    )
    source = pye57.E57(str(e57_path))
    reports, sampled = [], []
    try:
        for index, node in enumerate(nodes):
            data = source.read_scan(
                index, colors=True, transform=True, ignore_missing_fields=True
            )
            points = (
                np.column_stack(
                    [data[k] for k in ["cartesianX", "cartesianY", "cartesianZ"]]
                )
                @ C.T
            )
            finite = np.isfinite(points).all(1)
            points = points[finite]
            colors = None
            if "colorRed" in data:
                colors = np.column_stack(
                    [data[k] for k in ["colorRed", "colorGreen", "colorBlue"]]
                )[finite]
            del data
            camera = np.array(list(node["position"].values()))
            expected_height = (
                float(np.median([r["floor"]["cameraHeight"] for r in reports]))
                if reports
                else None
            )
            level, floor_report = estimate_floor(points[::3], camera, expected_height)
            node["floorPosition"] = {**node["position"], "y": level + 0.025}
            node["floorEstimate"] = floor_report
            rotation = Rotation.from_quat(node["quaternion"]).as_matrix()
            local = (points - camera) @ rotation
            # Independent color reprojection: the measured point RGB should agree with
            # the photograph at its geometric ray, without choosing a fitted rotation.
            check = local[:: max(1, len(local) // 16000)]
            check_colors = (
                colors[:: max(1, len(local) // 16000)] if colors is not None else None
            )
            error = []
            depth_coverages = []
            for face in range(6):
                basis = np.stack([RIGHTS[face], -UPS[face], CENTERS[face]], axis=1)
                coords = local @ basis
                z = coords[:, 2]
                mask = (
                    (z > 0.1)
                    & (np.abs(coords[:, 0]) <= z)
                    & (np.abs(coords[:, 1]) <= z)
                )
                q = coords[mask]
                uv = np.floor(q[:, :2] / q[:, 2:] * size / 2 + size / 2).astype(
                    np.int32
                )
                uv = np.clip(uv, 0, size - 1)
                depth = np.full(size * size, np.inf, dtype=np.float32)
                np.minimum.at(
                    depth, uv[:, 1] * size + uv[:, 0], q[:, 2].astype(np.float32)
                )
                depth = depth.reshape(size, size)
                # Fill only one-pixel sampling gaps in locally continuous surfaces.
                near = minimum_filter(depth, size=3)
                far = maximum_filter(np.where(np.isfinite(depth), depth, 0), size=3)
                fill = ~np.isfinite(depth) & np.isfinite(near) & ((far - near) < 0.08)
                depth[fill] = near[fill]
                depth[~np.isfinite(depth)] = 0
                depth_coverages.append(float(np.mean(depth > 0)))
                image_path = dataset_dir / "faces" / node["uuid"] / f"face{face}.jpg"
                with Image.open(image_path) as image:
                    photo = np.ascontiguousarray(
                        image.resize((size, size), Image.Resampling.LANCZOS),
                        dtype=np.uint8,
                    )
                if check_colors is not None:
                    cq = check @ basis
                    cz = cq[:, 2]
                    cm = (cz > 0.1) & (np.abs(cq[:, :2]) < cz[:, None] * 0.97).all(1)
                    cuv = np.clip(
                        np.floor(cq[cm, :2] / cq[cm, 2:] * size / 2 + size / 2).astype(
                            int
                        ),
                        0,
                        size - 1,
                    )
                    error.extend(
                        np.abs(
                            photo[cuv[:, 1], cuv[:, 0]].astype(float) - check_colors[cm]
                        )
                        / 255
                    )
                rgbd = o3d.geometry.RGBDImage.create_from_color_and_depth(
                    o3d.geometry.Image(photo),
                    o3d.geometry.Image(depth),
                    depth_scale=1,
                    depth_trunc=60,
                    convert_rgb_to_intensity=False,
                )
                world_to_camera = (rotation @ basis).T
                extrinsic = np.eye(4)
                extrinsic[:3, :3] = world_to_camera
                extrinsic[:3, 3] = -world_to_camera @ camera
                volume.integrate(rgbd, intrinsic, extrinsic)
            median = float(np.median(np.mean(error, axis=1))) if len(error) else None
            if median is not None and median > 0.12:
                raise ValueError(
                    f"Point/image registration failed for {node['uuid']}: median RGB error {median:.4f}"
                )
            reports.append(
                {
                    "node": node["uuid"],
                    "points": len(points),
                    "photoMedianAbsoluteError": median,
                    "depthCoverage": depth_coverages,
                    "floor": floor_report,
                }
            )
            sampled.append(points[:: max(1, len(points) // 5000)].astype(np.float32))
            print(
                f"fusion {index + 1}/{len(nodes)}: {len(points):,} points, photo error {median}, floor {level:.3f} m",
                flush=True,
            )
    finally:
        source.close()
    print("extracting fused surface", flush=True)
    mesh = volume.extract_triangle_mesh()
    mesh.remove_degenerate_triangles().remove_duplicated_triangles().remove_duplicated_vertices()
    before = len(mesh.triangles)
    if before > args.target_triangles:
        mesh = mesh.simplify_quadric_decimation(args.target_triangles)
    mesh.remove_degenerate_triangles().remove_duplicated_triangles().remove_unreferenced_vertices()
    mesh.compute_vertex_normals()
    if len(mesh.triangles) == 0:
        raise ValueError("Fusion produced an empty mesh")
    export_mesh(mesh, out_path)
    ray_scene = o3d.t.geometry.RaycastingScene()
    ray_scene.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(mesh))
    samples = np.concatenate(sampled)
    distances = ray_scene.compute_distance(o3d.core.Tensor(samples)).numpy()
    graph = build_graph(nodes, ray_scene)
    quality = {
        "schema": "sphr-registration-qa-v2",
        "scans": reports,
        "pointToMeshMeters": {
            "median": float(np.median(distances)),
            "p95": float(np.quantile(distances, 0.95)),
        },
        "navigation": graph,
    }
    (dataset_dir / "quality.json").write_text(json.dumps(quality, indent=2) + "\n")
    return {
        "meshMethod": "tsdf",
        "trianglesBeforeSimplify": before,
        "triangles": len(mesh.triangles),
        "vertices": len(mesh.vertices),
        "targetTriangles": args.target_triangles,
        "voxelSize": args.voxel_size,
        "depthSize": size,
        "bytes": out_path.stat().st_size,
        "bounds": {
            "min": mesh.get_min_bound().tolist(),
            "max": mesh.get_max_bound().tolist(),
        },
        "quality": quality["pointToMeshMeters"],
    }


def build_graph(nodes, scene):
    points = np.array([[n["position"][k] for k in "xyz"] for n in nodes])
    floors = np.array([[n["floorPosition"][k] for k in "xyz"] for n in nodes])
    lengths = np.linalg.norm(points[:, None] - points[None, :], axis=2)
    edges = []
    for i, node in enumerate(nodes):
        candidates = np.argsort(lengths[i])[1:]
        neighbors = []
        for j in candidates:
            dist = lengths[i, j]
            if dist > 8:
                break
            # Camera line of sight keeps links out of intervening rooms. Floor visibility
            # keeps rings off objects/walls. Stair connections may change floor height.
            targets = [points[j], floors[j] + [0, 0.12, 0]]
            rays = np.array(
                [
                    np.r_[points[i], (t - points[i]) / np.linalg.norm(t - points[i])]
                    for t in targets
                ],
                dtype=np.float32,
            )
            hits = scene.cast_rays(o3d.core.Tensor(rays))["t_hit"].numpy()
            if all(
                h >= np.linalg.norm(t - points[i]) - 0.2 for h, t in zip(hits, targets)
            ):
                neighbors.append(nodes[j]["uuid"])
                edges.append((i, int(j)))
        node["neighbors"] = neighbors[:10]
    # Report disconnected components honestly; never add a through-wall link to force connectivity.
    remaining = set(range(len(nodes)))
    components = []
    adjacency = {i: set() for i in remaining}
    for i, j in edges:
        adjacency[i].add(j)
        adjacency[j].add(i)
    while remaining:
        queue = [remaining.pop()]
        component = []
        while queue:
            i = queue.pop()
            component.append(nodes[i]["uuid"])
            for j in adjacency[i] & remaining:
                remaining.remove(j)
                queue.append(j)
        components.append(component)
    return {
        "directedEdges": len(edges),
        "components": components,
        "isolatedNodes": [n["uuid"] for n in nodes if not n["neighbors"]],
    }
