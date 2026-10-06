"""Check every delivered panorama against raycast colors from its delivered GLB.

Quarter-turn negative controls detect orientation mistakes that seam checks miss.
This tests consistency of viewer assets, not accuracy against raw scan measurements.
"""
import argparse
import json
from pathlib import Path

import numpy as np
import open3d as o3d
from PIL import Image
from scipy.spatial.transform import Rotation
import trimesh

from catalog import atomic_json
from geometry import CENTERS, RIGHTS, UPS
from web_archive import digest


def audit(folder, size=32):
    manifest = json.loads((folder / "manifest.json").read_text())
    bootstrap = json.loads((folder / "bootstrap.json").read_text())
    scene = trimesh.load(folder / manifest["mesh"]["path"], force="scene", process=False)
    raycaster = o3d.t.geometry.RaycastingScene()
    meshes = []
    for name in sorted(scene.geometry):
        mesh = scene.geometry[name]
        raycaster.add_triangles(o3d.core.Tensor(mesh.vertices.astype("float32")),
                               o3d.core.Tensor(mesh.faces.astype("uint32")))
        texture = np.asarray(mesh.visual.material.baseColorTexture.convert("RGB"), dtype=float) / 255
        meshes.append((mesh, texture))
    axis = (np.arange(size) + .5) * 2 / size - 1
    u, v = np.meshgrid(axis, -axis)
    local = np.concatenate([(CENTERS[f] + u[..., None] * RIGHTS[f] + v[..., None] * UPS[f]).reshape(-1, 3)
                            for f in range(6)])
    prefix = manifest["datasetUrl"] + "/"
    records = []
    for node in bootstrap["space"]["space_data"]["nodes"]:
        photos = np.concatenate([np.asarray(Image.open(folder / url[len(prefix):]).convert("RGB").resize((size, size)),
                                             dtype=float).reshape(-1, 3) / 255 for url in node["faces"]])
        origin = np.array([node["position"][k] for k in "xyz"])
        scores, hits = {}, {}
        for angle in [0, 90, 180, 270]:
            rotation = Rotation.from_quat(node["quaternion"]) * Rotation.from_euler("y", angle, degrees=True)
            directions = rotation.apply(local)
            directions /= np.linalg.norm(directions, axis=1)[:, None]
            rays = np.column_stack([np.repeat(origin[None], len(directions), axis=0), directions]).astype("float32")
            result = raycaster.cast_rays(o3d.core.Tensor(rays))
            distances = result["t_hit"].numpy()
            ids, triangles = result["geometry_ids"].numpy(), result["primitive_ids"].numpy()
            barycentric = result["primitive_uvs"].numpy()
            valid = np.isfinite(distances) & (distances > .05)
            colors = np.zeros_like(directions)
            for index, (mesh, texture) in enumerate(meshes):
                selected = valid & (ids == index)
                bary = barycentric[selected]
                weights = np.column_stack([1 - bary.sum(axis=1), bary])
                uv = np.sum(mesh.visual.uv[mesh.faces[triangles[selected]]] * weights[:, :, None], axis=1)
                x = np.clip(np.rint(uv[:, 0] * (texture.shape[1] - 1)).astype(int), 0, texture.shape[1] - 1)
                y = np.clip(np.rint((1 - uv[:, 1]) * (texture.shape[0] - 1)).astype(int), 0, texture.shape[0] - 1)
                colors[selected] = texture[y, x]
            if not valid.any():
                raise ValueError(f"No mesh support for panorama {node['uuid']}")
            scores[str(angle)] = float(np.median(np.abs(colors[valid] - photos[valid]).mean(axis=1)))
            hits[str(angle)] = int(valid.sum())
        records.append({"node": node["uuid"], "sourceIndex": node["index"], "raysPerOrientation": len(local),
                        "meshHits": hits, "medianRgbError": scores,
                        "orientationDiscriminated": scores["0"] < min(scores[str(a)] for a in [90, 180, 270])})
    return {"schema": "sphr-web-alignment-audit-v1", "sourceBinding": manifest["sourceSha256"],
            "bootstrapSha256": digest(folder / "bootstrap.json"), "meshSha256": digest(folder / manifest["mesh"]["path"]),
            "method": "Delivered cube photos vs delivered textured mesh raycasts; fixed quarter-turn negative controls",
            "rawMeasurementRegistration": False, "allOrientationsDiscriminated": all(r["orientationDiscriminated"] for r in records),
            "nodes": records}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = audit(args.package)
    if args.output:
        atomic_json(args.output, report)
    print(json.dumps(report, indent=2))
