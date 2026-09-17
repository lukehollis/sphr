import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch
from itertools import combinations
import numpy as np
import open3d as o3d
from reduction import ReductionCheckpoint, reduce_mesh


class ReductionTests(unittest.TestCase):
    def test_reduces_real_surface_without_changing_scale(self):
        source = o3d.geometry.TriangleMesh.create_sphere(radius=3, resolution=80)
        source.paint_uniform_color([.2, .4, .6])
        reduced, passes = reduce_mesh(source, 1000)
        self.assertLessEqual(len(reduced.triangles), 1000)
        self.assertGreater(len(reduced.triangles), 0)
        self.assertTrue(passes)
        self.assertLess(np.max(np.abs(np.linalg.norm(np.asarray(reduced.vertices), axis=1) - 3)), .1)
        self.assertTrue(np.isfinite(np.asarray(reduced.vertices)).all())
        self.assertTrue(reduced.has_vertex_colors())

    def test_preserves_surface_already_within_budget(self):
        mesh = o3d.geometry.TriangleMesh.create_box()
        reduced, passes = reduce_mesh(mesh, 50_000)
        self.assertEqual(len(reduced.triangles), 12)
        self.assertEqual(passes, [])

    def test_fragmented_surface_meets_budget_and_preserves_building(self):
        source = o3d.geometry.TriangleMesh.create_box(8, 4, 6).subdivide_midpoint(3)
        # Overlapping tiny non-manifold patches can consume the whole QEM
        # budget, erasing ordinary walls before the fragments are simplified.
        rng = np.random.default_rng(7)
        shard_vertices = rng.uniform(0, .005, (6, 3))
        shard_faces = np.array(list(combinations(range(6), 3)))
        centers = rng.uniform([0, 0, 0], [8, 4, 6], (1000, 1, 3))
        vertices = (centers + shard_vertices).reshape(-1, 3)
        faces = (shard_faces[None, :, :] + np.arange(len(centers))[:, None, None] * 6).reshape(-1, 3)
        source += o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(vertices),
                                          o3d.utility.Vector3iVector(faces))
        source.paint_uniform_color([.2, .4, .6])
        reduced, passes = reduce_mesh(source, 500)
        self.assertLessEqual(len(reduced.triangles), 500)
        self.assertTrue(any(p['method'] == 'remove-non-manifold-edges' for p in passes))
        np.testing.assert_allclose(reduced.get_min_bound(), [0, 0, 0], atol=.08)
        np.testing.assert_allclose(reduced.get_max_bound(), [8, 4, 6], atol=.08)
        scene = o3d.t.geometry.RaycastingScene()
        scene.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(reduced))
        queries = np.array([[4, 0, 3], [4, 4, 3], [0, 2, 3], [8, 2, 3], [4, 2, 0], [4, 2, 6]], dtype=np.float32)
        self.assertLess(float(scene.compute_distance(o3d.core.Tensor(queries)).numpy().max()), .08)

    def test_resumes_completed_reduction_and_rejects_changed_binding_or_mesh(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = o3d.geometry.TriangleMesh.create_sphere(radius=3, resolution=80)
            checkpoint = ReductionCheckpoint(root, 'verified-measured-source', 1000)
            first, passes = reduce_mesh(source, 1000, checkpoint)
            with patch('reduction.clean', side_effect=AssertionError('Repeated a completed pass')):
                resumed, saved = reduce_mesh(source, 1000, checkpoint)
            self.assertEqual(passes, saved)
            np.testing.assert_allclose(first.vertices, resumed.vertices)
            with self.assertRaisesRegex(ValueError, 'differs'):
                ReductionCheckpoint(root, 'another-source', 1000).load()
            with self.assertRaisesRegex(ValueError, 'differs'):
                ReductionCheckpoint(root, 'verified-measured-source', 900).load()
            next(root.glob('reduction-*.ply')).write_bytes(b'corrupt mesh')
            with self.assertRaisesRegex(ValueError, 'content changed'):
                checkpoint.load()

    def test_bounds_large_working_surface_before_qem_and_resumes_interruption(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = o3d.geometry.TriangleMesh.create_sphere(radius=3, resolution=80)
            checkpoint = ReductionCheckpoint(temporary, 'large-measured-source', 1000)
            save = checkpoint.save

            def interrupt(mesh, passes):
                save(mesh, passes)
                raise InterruptedError('Simulated stop after a durable pass')

            # Exercise the same working-set path at a smaller regression scale.
            with patch('reduction.WORKING_TRIANGLES', 6000), patch.object(checkpoint, 'save', interrupt):
                with self.assertRaises(InterruptedError):
                    reduce_mesh(source, 1000, checkpoint)
            with patch('reduction.WORKING_TRIANGLES', 6000):
                mesh, passes = reduce_mesh(source, 1000, checkpoint)
            self.assertEqual(sum(p['step'] == 'working-cluster-0' for p in passes), 1)
            self.assertLessEqual(len(mesh.triangles), 1000)
            self.assertLess(np.max(np.abs(np.linalg.norm(np.asarray(mesh.vertices), axis=1) - 3)), .12)


if __name__ == '__main__':
    unittest.main()
