"""Quadric mesh reduction with an enforced ceiling and recorded fallback passes."""
import numpy as np
import open3d as o3d
from scipy.spatial import cKDTree


def reduce_mesh(mesh, target):
    passes = []
    for weight in [1.0, 0.1, 0.0]:
        before = len(mesh.triangles)
        if before <= target:
            break
        mesh = mesh.simplify_quadric_decimation(target, boundary_weight=weight)
        mesh.remove_degenerate_triangles().remove_duplicated_triangles().remove_unreferenced_vertices()
        passes.append({'method': 'open3d-qem', 'boundaryWeight': weight, 'before': before, 'after': len(mesh.triangles)})
        print(f"quadric reduction (boundary {weight}): {before:,} → {len(mesh.triangles):,} triangles", flush=True)
    if len(mesh.triangles) > target:
        import fast_simplification
        vertices, triangles = np.asarray(mesh.vertices), np.asarray(mesh.triangles)
        colors = np.asarray(mesh.vertex_colors) if mesh.has_vertex_colors() else None
        for aggression in [7, 9]:
            points, faces = fast_simplification.simplify(vertices, triangles, target_count=target, agg=aggression)
            passes.append({'method': 'fast-qem', 'aggression': aggression, 'before': len(triangles), 'after': len(faces)})
            print(f"quadric reduction (aggression {aggression}): {len(triangles):,} → {len(faces):,} triangles", flush=True)
            if len(faces) <= target:
                mesh = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(points), o3d.utility.Vector3iVector(faces))
                if colors is not None:
                    nearest = cKDTree(vertices).query(points)[1]
                    mesh.vertex_colors = o3d.utility.Vector3dVector(colors[nearest])
                break
    mesh.remove_degenerate_triangles().remove_duplicated_triangles().remove_unreferenced_vertices()
    if not 0 < len(mesh.triangles) <= target:
        raise ValueError(f'Quadric reduction could not meet {target:,} triangles; got {len(mesh.triangles):,}')
    return mesh, passes
