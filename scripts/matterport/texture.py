"""Bake calibrated panorama photographs onto the reduced mesh's UV atlas."""

import json
from pathlib import Path
import numpy as np
import open3d as o3d
from PIL import Image
from scipy.spatial.transform import Rotation
import trimesh
import xatlas
from geometry import CENTERS, RIGHTS, UPS


def texture_mesh(mesh_path, dataset_dir, nodes, size=4096):
    mesh = o3d.io.read_triangle_mesh(str(mesh_path))
    mesh.compute_vertex_normals()
    vertices = np.asarray(mesh.vertices)
    triangles = np.asarray(mesh.triangles)
    centers = vertices[triangles].mean(1)
    normals = np.cross(
        vertices[triangles[:, 1]] - vertices[triangles[:, 0]],
        vertices[triangles[:, 2]] - vertices[triangles[:, 0]],
    )
    normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-8)
    cameras = np.array([[n["position"][k] for k in "xyz"] for n in nodes])
    delta = cameras[None] - centers[:, None]
    distances = np.linalg.norm(delta, axis=2)
    cosine = np.sum(delta * normals[:, None], axis=2) / np.maximum(distances, 1e-8)
    scores = np.maximum(cosine, 0) / (distances**2 + 0.25)
    candidates = np.argsort(-scores, axis=1)[:, : min(8, len(nodes))]
    scene = o3d.t.geometry.RaycastingScene()
    tensor_mesh = o3d.t.geometry.TriangleMesh.from_legacy(mesh)
    scene.add_triangles(tensor_mesh)
    assignments = np.full(len(triangles), -1, dtype=np.int32)
    for rank in range(candidates.shape[1]):
        ids = np.flatnonzero(assignments < 0)
        cameras_idx = candidates[ids, rank]
        origins = cameras[cameras_idx]
        direction = centers[ids] - origins
        length = np.linalg.norm(direction, axis=1)
        rays = np.concatenate([origins, direction / length[:, None]], axis=1).astype(
            np.float32
        )
        hits = scene.cast_rays(o3d.core.Tensor(rays))["t_hit"].numpy()
        visible = (hits >= length - 0.12) & (scores[ids, cameras_idx] > 0)
        assignments[ids[visible]] = cameras_idx[visible]
    covered = float(np.mean(assignments >= 0))
    # Any unobserved back-facing triangles retain interpolated source color, not a projected wall.
    print(
        f"texture: {covered:.1%} of triangles have a visible camera; unwrapping {len(triangles):,} triangles",
        flush=True,
    )
    atlas = xatlas.Atlas()
    atlas.add_mesh(vertices.astype(np.float32), triangles.astype(np.uint32))
    pack = xatlas.PackOptions()
    pack.resolution = size
    pack.padding = 4
    atlas.generate(pack_options=pack)
    mapping, indices, uvs = atlas[0]
    # xatlas preserves triangle order; UV vertices may split at chart boundaries.
    np.testing.assert_array_equal(mapping[indices], triangles)
    tensor_mesh.triangle["texture_uvs"] = o3d.core.Tensor(
        uvs[indices].astype(np.float32)
    )
    tensor_mesh.triangle["camera_id"] = o3d.core.Tensor(
        assignments[:, None].astype(np.float32)
    )
    position = tensor_mesh.bake_vertex_attr_textures(
        size, {"positions"}, margin=3, fill=float("nan"), update_material=False
    )["positions"].numpy()
    camera_map = (
        tensor_mesh.bake_triangle_attr_textures(
            size, {"camera_id"}, margin=3, fill=-1, update_material=False
        )["camera_id"]
        .numpy()
        .reshape(size, size)
    )
    colors = tensor_mesh.bake_vertex_attr_textures(
        size, {"colors"}, margin=3, fill=0, update_material=False
    )["colors"].numpy()
    # GLB vertex colors were already linearized; restore sRGB for the fallback bitmap.
    colors = np.where(
        colors <= 0.0031308,
        colors * 12.92,
        1.055 * np.maximum(colors, 0) ** (1 / 2.4) - 0.055,
    )
    image = np.clip(colors * 255, 0, 255).astype(np.uint8)
    del colors
    for index, node in enumerate(nodes):
        mask = (camera_map == index) & np.isfinite(position).all(2)
        if not mask.any():
            continue
        xyz = position[mask]
        local = (xyz - cameras[index]) @ Rotation.from_quat(
            node["quaternion"]
        ).as_matrix()
        face_id = np.argmax(local @ CENTERS.T, axis=1)
        result = np.zeros((len(xyz), 3), dtype=np.uint8)
        for face in range(6):
            selected = face_id == face
            if not selected.any():
                continue
            direction = local[selected]
            z = direction @ CENTERS[face]
            uv = (
                np.column_stack(
                    [direction @ RIGHTS[face] / z, -direction @ UPS[face] / z]
                )
                * 0.5
                + 0.5
            )
            with Image.open(
                Path(dataset_dir) / "faces" / node["uuid"] / f"face{face}.jpg"
            ) as photo:
                pixels = np.asarray(photo.convert("RGB"))
            coords = np.clip(
                uv * np.array([pixels.shape[1], pixels.shape[0]]) - 0.5,
                0,
                [pixels.shape[1] - 1.001, pixels.shape[0] - 1.001],
            )
            low = coords.astype(int)
            weight = coords - low
            x, y = low[:, 0], low[:, 1]
            wx, wy = weight[:, 0:1], weight[:, 1:2]
            value = (
                pixels[y, x] * (1 - wx) * (1 - wy)
                + pixels[y, x + 1] * wx * (1 - wy)
                + pixels[y + 1, x] * (1 - wx) * wy
                + pixels[y + 1, x + 1] * wx * wy
            )
            result[selected] = np.clip(value, 0, 255).astype(np.uint8)
        image[mask] = result
    texture_path = Path(dataset_dir) / "mesh" / "atlas.jpg"
    Image.fromarray(image).save(texture_path, quality=94, subsampling=0)
    uv = tensor_mesh.triangle.texture_uvs.numpy().reshape(-1, 2)
    # glTF stores per-vertex UVs; split shared vertices at chart boundaries without changing faces.
    material = trimesh.visual.material.PBRMaterial(
        baseColorTexture=Image.open(texture_path),
        metallicFactor=0,
        roughnessFactor=1,
        doubleSided=False,
    )
    output = trimesh.Trimesh(
        vertices=vertices[triangles].reshape(-1, 3),
        faces=np.arange(len(triangles) * 3).reshape(-1, 3),
        vertex_normals=np.asarray(mesh.vertex_normals)[triangles].reshape(-1, 3),
        visual=trimesh.visual.TextureVisuals(uv=uv, material=material),
        process=False,
    )
    output.export(mesh_path)
    result = {
        "size": size,
        "visibleCameraCoverage": covered,
        "charts": int(atlas.get_mesh_chart_count(0)),
        "bytes": texture_path.stat().st_size,
    }
    print("texture complete", result, flush=True)
    return result


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path)
    args = parser.parse_args()
    bootstrap = json.loads((args.dataset / "bootstrap.json").read_text())
    manifest = json.loads((args.dataset / "manifest.json").read_text())
    print(
        texture_mesh(
            args.dataset / "mesh" / f"{manifest['slug']}-50k.glb",
            args.dataset,
            bootstrap["space"]["space_data"]["nodes"],
        )
    )
