"""Fuse measured range data, derive floors, and certify point/photo alignment."""

import json
import numpy as np
import open3d as o3d
import pye57
from PIL import Image
from scipy.ndimage import maximum_filter, minimum_filter
from scipy.spatial.transform import Rotation
from scipy.spatial import ConvexHull, QhullError
from geometry import C, CENTERS, RIGHTS, UPS, estimate_floor
from reduction import reduce_mesh


def fuse(e57_path, nodes, dataset_dir, out_path, args, export_mesh):
    fusion = Fusion(dataset_dir, args)
    fusion.integrate(e57_path, nodes)
    return fusion.finish(nodes, out_path, export_mesh)


class Fusion:
    """One measured TSDF volume shared across every E57 part of a capture."""

    def __init__(self, dataset_dir, args):
        self.volume = o3d.pipelines.integration.ScalableTSDFVolume(
            voxel_length=args.voxel_size,
            sdf_trunc=args.voxel_size * 4,
            color_type=o3d.pipelines.integration.TSDFVolumeColorType.RGB8,
            depth_sampling_stride=2,
        )
        self.args = args
        self.dataset_dir = dataset_dir
        self.reports, self.sampled = [], []
        self.image_buffer = None
        size = args.depth_size
        self.intrinsic = o3d.camera.PinholeCameraIntrinsic(
            size, size, size / 2, size / 2, size / 2 - 0.5, size / 2 - 0.5
        )

    def integrate(self, e57_path, nodes):
        source = pye57.E57(str(e57_path))
        reports, sampled = self.reports, self.sampled
        volume, intrinsic = self.volume, self.intrinsic
        dataset_dir, size = self.dataset_dir, self.args.depth_size
        try:
            for index, node in enumerate(nodes):
                data = source.read_scan(
                    node["matterport"].get("sourceScanIndex", index), colors=True, transform=True, ignore_missing_fields=True
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
                heights = [r["floor"]["cameraHeight"] for r in reports if "cameraHeight" in r["floor"]]
                expected_height = float(np.median(heights)) if heights else None
                try:
                    level, floor_report = estimate_floor(points[::3], camera, expected_height)
                except ValueError as error:
                    level = float('nan')
                    floor_report = {"method": "pending-measured-mesh", "reason": str(error)}
                node["floorPosition"] = {**node["position"], "y": level + 0.025}
                node.pop('floorUnobserved', None)
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
                    with Image.open(self.image_buffer.source(image_path) if self.image_buffer is not None else image_path) as image:
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

    def finish(self, nodes, out_path, export_mesh):
        args, dataset_dir = self.args, self.dataset_dir
        volume, sampled, reports = self.volume, self.sampled, self.reports
        print("extracting fused surface", flush=True)
        checkpoint = args.processed_root / args.slug / 'geometry-checkpoint' if hasattr(args, 'processed_root') else None
        if getattr(args, 'resume_geometry', False):
            mesh = o3d.io.read_triangle_mesh(str(checkpoint / 'measured.ply'))
        else:
            mesh = volume.extract_triangle_mesh()
        self.volume = None
        del volume
        if not getattr(args, 'resume_geometry', False):
            print(f"cleaning measured surface: {len(mesh.triangles):,} triangles", flush=True)
            mesh.remove_degenerate_triangles().remove_duplicated_triangles().remove_duplicated_vertices()
            if checkpoint is not None:
                from checkpoint import save_surface
                save_surface(checkpoint, mesh, sampled, reports)
        # The source-bound checkpoint already contains this cleaned surface.
        # Rebuilding its large duplicate maps can exhaust RAM without changing it.
        print(f"refining floors against {len(mesh.triangles):,} measured triangles", flush=True)
        refine_floors(nodes, reports, mesh)
        before = len(mesh.triangles)
        print(f"reducing {before:,} triangles to at most {args.target_triangles:,}", flush=True)
        mesh, reduction = reduce_mesh(mesh, args.target_triangles)
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
            "reduction": reduction,
            "triangles": len(mesh.triangles),
            "vertices": len(mesh.vertices),
            "targetTriangles": args.target_triangles,
            "voxelSize": args.voxel_size,
            "depthSize": args.depth_size,
            "bytes": out_path.stat().st_size,
            "bounds": {
                "min": mesh.get_min_bound().tolist(),
                "max": mesh.get_max_bound().tolist(),
            },
            "quality": quality["pointToMeshMeters"],
        }


def footprint_floor(scene, camera):
    """Interpolate a measured sloping/stepped patch across a small tripod gap."""
    for radius in (.15, .3, .5):
        grid = np.array([(x, z) for x in np.linspace(-radius, radius, 9)
                         for z in np.linspace(-radius, radius, 9) if x*x + z*z <= radius*radius + 1e-9])
        origins = np.tile(camera, (len(grid), 1))
        origins[:, [0, 2]] += grid
        rays = np.column_stack([origins, np.tile([0, -1, 0], (len(grid), 1))]).astype(np.float32)
        hits = scene.cast_rays(o3d.core.Tensor(rays))
        distances, normals = hits['t_hit'].numpy(), hits['primitive_normals'].numpy()
        valid = np.isfinite(distances) & (distances > .3) & (normals[:, 1] > .45)
        if np.count_nonzero(valid) < 6:
            continue
        xy, levels = grid[valid], camera[1] - distances[valid]
        design = np.column_stack([xy, np.ones(len(xy))])
        # Fit the observed patch, trimming separated surfaces rather than spanning floors.
        keep = np.ones(len(levels), dtype=bool)
        for _ in range(4):
            coef = np.linalg.lstsq(design[keep], levels[keep], rcond=None)[0]
            residual = np.abs(design @ coef - levels)
            keep = residual <= .12
            if np.count_nonzero(keep) < 6:
                break
        if np.count_nonzero(keep) < 6 or np.linalg.norm(coef[:2]) > 1.5 or camera[1] - coef[2] <= .3:
            continue
        try:
            hull = ConvexHull(xy[keep])
        except QhullError:
            continue
        if hull.volume < .01 or np.max(hull.equations[:, 2]) > .06:
            continue
        return float(coef[2]), {'method': 'measured-tsdf-footprint', 'cameraHeight': float(camera[1] - coef[2]),
                              'searchRadiusMeters': radius, 'points': int(np.count_nonzero(keep)),
                              'slope': float(np.linalg.norm(coef[:2])),
                              'maxResidualMeters': float(np.max(residual[keep])),
                              'footprintAreaSquareMeters': float(hull.volume)}
    return None


def refine_floors(nodes, reports, mesh, scene=None):
    """Resolve markers on the measured surface directly below each source camera.

    Local height histograms can include shelves and decorative wall bands. Their
    convex hulls can span empty space. A downward hit on the full fused surface
    checks actual support at the camera footprint before geometry reduction.
    """
    if scene is None:
        scene = o3d.t.geometry.RaycastingScene()
        scene.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(mesh))
    cameras = np.array([[node['position'][k] for k in 'xyz'] for node in nodes])
    rays = np.column_stack([cameras, np.tile([0, -1, 0], (len(nodes), 1))]).astype(np.float32)
    hits = scene.cast_rays(o3d.core.Tensor(rays))
    distances = hits['t_hit'].numpy()
    normals = hits['primitive_normals'].numpy()
    for node, report, distance, normal in zip(nodes, reports, distances, normals):
        node.pop('floorUnobserved', None)
        if np.isfinite(distance) and distance > 0.3 and normal[1] > 0.65:
            previous = node['floorEstimate']
            measured = {'method': 'measured-tsdf-surface', 'cameraHeight': float(distance),
                        'surfaceNormal': normal.tolist(), 'localPlaneCandidate': previous}
            node['floorEstimate'] = measured
            node['floorPosition'] = {**node['position'], 'y': node['position']['y'] - float(distance) + 0.025}
            report['floor'] = measured
        else:
            candidate = footprint_floor(scene, np.array([node['position'][k] for k in 'xyz']))
            if candidate is not None:
                level, measured = candidate
                measured['localPlaneCandidate'] = node['floorEstimate']
                node['floorPosition'] = {**node['position'], 'y': level + .025}
                node['floorEstimate'] = report['floor'] = measured
            elif node.get('floorPosition') is None or not np.isfinite(node['floorPosition']['y']):
                node['floorPosition'] = None
                node['floorUnobserved'] = True
                node['floorEstimate'] = report['floor'] = {
                    'method': 'unobserved',
                    'reason': 'Neither source points nor the fused surface support a floor beneath this camera',
                    'access': 'camera-point',
                }
            else:
                report['floor']['meshNadirUnobserved'] = True


def build_graph(nodes, scene):
    points = np.array([[n["position"][k] for k in "xyz"] for n in nodes])
    floors = np.array([[(n.get('floorPosition') or n['position'])[k] for k in "xyz"] for n in nodes])
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
            targets = [points[j]] if nodes[j].get('floorUnobserved') else [points[j], floors[j] + [0, 0.12, 0]]
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
                if len(neighbors) == 10:
                    break
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
        "cameraPointNodes": [n['uuid'] for n in nodes if n.get('floorUnobserved')],
    }
