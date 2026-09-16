import unittest
import numpy as np
from scipy.spatial.transform import Rotation
from geometry import C, CENTERS, RIGHTS, UPS, camera_face_assignment, estimate_floor


class CameraGeometryTests(unittest.TestCase):
    def test_shuffled_faces_and_arbitrary_scan_rotations(self):
        rng = np.random.default_rng(314)
        for _ in range(20):
            scan = Rotation.random(random_state=rng).as_matrix()
            group = C @ scan @ C.T
            sources = []
            for face in range(6):
                turn = int(rng.integers(4))
                r, u = group @ RIGHTS[face], group @ UPS[face]
                r, u = [(r, u), (-u, r), (-r, -u), (u, -r)][turn]
                sources.append(C.T @ np.stack([r, u, -group @ CENTERS[face]], axis=1))
            rng.shuffle(sources)
            actual, assignments = camera_face_assignment(scan, sources)
            np.testing.assert_allclose(actual, group, atol=1e-12)
            self.assertEqual(len({i for i, _, _ in assignments}), 6)
            self.assertLess(max(e for _, _, e in assignments), 1e-12)

    def test_duplicate_and_non_cube_cameras_are_rejected(self):
        with self.assertRaises(ValueError):
            camera_face_assignment(np.eye(3), [np.eye(3)] * 6)

    def test_metric_conversion_preserves_distance_and_handedness(self):
        self.assertAlmostEqual(np.linalg.det(C), 1)
        points = np.random.default_rng(1).normal(size=(50, 3)) * 10
        np.testing.assert_allclose(
            np.linalg.norm(points - points[0], axis=1),
            np.linalg.norm(points @ C.T - points[0] @ C.T, axis=1),
        )

    def test_floor_search_with_missing_nadir(self):
        x, z = np.meshgrid(np.linspace(-3, 3, 121), np.linspace(-3, 3, 121))
        points = np.column_stack([x.ravel(), (0.01 * x - 0.015 * z).ravel(), z.ravel()])
        points = points[np.linalg.norm(points[:, [0, 2]], axis=1) > 1.7]
        floor, report = estimate_floor(points, np.array([0, 1.63, 0]), 1.6)
        self.assertAlmostEqual(floor, 0, places=5)
        self.assertGreater(report["searchRadiusMeters"], 1.5)

    def test_no_floor_does_not_invent_fixed_height(self):
        with self.assertRaises(ValueError):
            estimate_floor(np.array([[0, 2, 0]]), np.array([0, 1.5, 0]))


if __name__ == "__main__":
    unittest.main()
