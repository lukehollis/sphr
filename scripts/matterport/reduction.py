"""Measured-surface reduction, including fragmented scans that stall edge collapse."""
import json
import math
from pathlib import Path
import numpy as np
import open3d as o3d
from scipy.spatial import cKDTree
from checkpoint import digest


ALGORITHM = 'sphr-measured-reduction-v3'
WORKING_TRIANGLES = 5_000_000


def clean(mesh):
    return mesh.remove_degenerate_triangles().remove_duplicated_triangles().remove_unreferenced_vertices()


class ReductionCheckpoint:
    """Atomically retain progress, bound to the verified full measured surface."""
    def __init__(self, directory, source_hash, target):
        self.directory = Path(directory)
        self.binding = {'algorithm': ALGORITHM, 'measuredSha256': source_hash, 'target': target}
        self.receipt = self.directory / 'reduction.json'

    def load(self):
        if not self.receipt.exists():
            return None
        data = json.loads(self.receipt.read_text())
        if any(data.get(key) != value for key, value in self.binding.items()):
            raise ValueError('Reduction checkpoint source, algorithm or triangle budget differs')
        name = f"reduction-{data['sha256']}.ply"
        path = self.directory / name
        if digest(path) != data['sha256']:
            raise ValueError('Reduction checkpoint content changed')
        mesh = o3d.io.read_triangle_mesh(str(path))
        if (len(mesh.triangles) != data['triangles'] or not len(mesh.triangles)
                or not np.isfinite(np.asarray(mesh.vertices)).all()):
            raise ValueError('Invalid reduction checkpoint geometry')
        print(f"resuming reduced surface: {len(mesh.triangles):,} triangles", flush=True)
        return mesh, data['passes']

    def save(self, mesh, passes):
        self.directory.mkdir(parents=True, exist_ok=True)
        temporary = self.directory / 'reduction-writing.ply'
        if not o3d.io.write_triangle_mesh(str(temporary), mesh):
            raise ValueError('Could not save reduction progress')
        sha = digest(temporary)
        name = f'reduction-{sha}.ply'
        temporary.replace(self.directory / name)
        data = {**self.binding, 'sha256': sha, 'triangles': len(mesh.triangles), 'passes': passes}
        receipt = self.receipt.with_suffix('.writing.json')
        receipt.write_text(json.dumps(data, indent=2, allow_nan=False) + '\n')
        receipt.replace(self.receipt)
        # Keep the previous valid mesh until the new receipt is committed.
        for previous in self.directory.glob('reduction-*.ply'):
            if previous.name != name:
                previous.unlink()


def reduce_mesh(mesh, target, checkpoint=None):
    if target < 1 or not len(mesh.triangles):
        raise ValueError('Reduction requires a nonempty surface and positive triangle budget')
    restored = checkpoint.load() if checkpoint is not None else None
    if restored is not None:
        mesh, passes = restored
    else:
        passes = []

    def accept(candidate, step, **details):
        nonlocal mesh
        candidate = clean(candidate)
        before, after = len(mesh.triangles), len(candidate.triangles)
        if not after or after > before or not np.isfinite(np.asarray(candidate.vertices)).all():
            raise ValueError(f'Reduction {step} produced invalid geometry ({before} → {after})')
        mesh = candidate
        passes.append({'step': step, 'before': before, 'after': after, **details})
        print(f"reduction {step}: {before:,} → {after:,} triangles", flush=True)
        if checkpoint is not None:
            checkpoint.save(mesh, passes)

    def cluster(voxel, step):
        accept(mesh.simplify_vertex_clustering(voxel, contraction=o3d.geometry.SimplificationContraction.Average),
               step, method='vertex-clustering', voxelSizeMeters=voxel,
               clusterDisplacementBoundMeters=math.sqrt(3) * voxel)

    def fast(aggression, step):
        import fast_simplification
        vertices, faces = np.asarray(mesh.vertices), np.asarray(mesh.triangles)
        points, triangles = fast_simplification.simplify(vertices, faces, target_count=target, agg=aggression)
        candidate = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(points), o3d.utility.Vector3iVector(triangles))
        if mesh.has_vertex_colors():
            nearest = cKDTree(vertices).query(points)[1]
            candidate.vertex_colors = o3d.utility.Vector3dVector(np.asarray(mesh.vertex_colors)[nearest])
        accept(candidate, step, method='fast-qem', aggression=aggression)

    # QEM's edge heap is prohibitively large for hundred-million-triangle TSDFs.
    # Averaging vertices within metric cells bounds its working set. Full source
    # geometry is retained separately for floors and final source-distance QA.
    prepasses = [p for p in passes if p['step'].startswith('working-cluster-')]
    voxel = prepasses[-1]['voxelSizeMeters'] * 1.5 if prepasses else math.sqrt(2 * mesh.get_surface_area() / WORKING_TRIANGLES)
    iteration = len(prepasses)
    while len(mesh.triangles) > max(WORKING_TRIANGLES, target):
        if iteration >= 20 or not np.isfinite(voxel) or voxel <= 0:
            raise ValueError('Could not bound the reduction working surface')
        cluster(voxel, f'working-cluster-{iteration}')
        iteration += 1
        voxel *= 1.5

    # More than two triangles sharing an edge stalls QEM. Remove the smallest
    # excess triangles, retaining measured vertex positions. Repeatedly enlarging
    # spatial cells to repair this topology would merge nearby tunnel walls.
    if len(mesh.triangles) > target and not any(p['step'] == 'manifold-edges' for p in passes):
        nonmanifold = len(mesh.get_non_manifold_edges(allow_boundary_edges=True))
        if nonmanifold:
            before_area, before_count = mesh.get_surface_area(), len(mesh.triangles)
            print(f'repairing {nonmanifold:,} non-manifold edges', flush=True)
            # Open3D mutates in place, so record the original count explicitly.
            mesh.remove_non_manifold_edges()
            removed_area = max(0., before_area - mesh.get_surface_area())
            passes.append({'step': 'manifold-edges', 'method': 'remove-non-manifold-edges',
                           'before': before_count, 'after': len(mesh.triangles),
                           'nonManifoldEdgesBefore': nonmanifold,
                           'removedAreaSquareMeters': removed_area,
                           'removedAreaFraction': removed_area / before_area if before_area else 0.})
            clean(mesh)
            if not len(mesh.triangles):
                raise ValueError('Repairing non-manifold edges removed the entire measured surface')
            if checkpoint is not None:
                checkpoint.save(mesh, passes)

    for weight in [1.0, 0.1, 0.0]:
        step = f'open3d-{weight}'
        if len(mesh.triangles) <= target:
            break
        if any(p['step'] == step for p in passes):
            continue
        accept(mesh.simplify_quadric_decimation(target, boundary_weight=weight), step,
               method='open3d-qem', boundaryWeight=weight)
    for aggression in [7, 9]:
        step = f'fast-{aggression}'
        if len(mesh.triangles) <= target:
            break
        if not any(p['step'] == step for p in passes):
            fast(aggression, step)

    # Residual topology may still stall both QEM implementations. Spatial
    # clustering merges nearby fragments and discards collapsed triangles,
    # without substituting a closed replacement surface.
    fragmented = [p for p in passes if p['step'].startswith('fragment-cluster-')]
    if fragmented and len(mesh.triangles) > target:
        pending_step = f"fragment-qem-{len(fragmented) - 1}"
        if not any(p['step'] == pending_step for p in passes):
            fast(7, pending_step)
    voxel = (fragmented[-1]['voxelSizeMeters'] * 1.5 if fragmented else
             math.sqrt(2 * mesh.get_surface_area() / len(mesh.triangles)) / 4)
    for iteration in range(len(fragmented), 24):
        if len(mesh.triangles) <= target:
            break
        cluster(voxel, f'fragment-cluster-{iteration}')
        if len(mesh.triangles) > target:
            fast(7, f'fragment-qem-{iteration}')
        voxel *= 1.5
    if not 0 < len(mesh.triangles) <= target:
        raise ValueError(f'Reduction could not meet {target:,} triangles; got {len(mesh.triangles):,}')
    return mesh, passes
