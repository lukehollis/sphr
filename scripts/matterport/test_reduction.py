import unittest
import numpy as np
import open3d as o3d
from reduction import reduce_mesh


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


if __name__ == '__main__':
    unittest.main()
