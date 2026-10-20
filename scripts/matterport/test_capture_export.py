from pathlib import Path
import struct
import tempfile
import unittest
import uuid

import numpy as np
from scipy.spatial.transform import Rotation

from capture_export import (MATTERPORT_FACES, add_alignment_links, face_file, find_job, fused_points, node_pose, read_manifest, source_file,
                            sphr_face, steady_floors)
from geometry import C, CENTERS, RIGHTS, UPS
from web_archive import graph_components


def varint(value):
    out = b""
    while True:
        byte, value = value & 0x7F, value >> 7
        out += bytes([byte | (0x80 if value else 0)])
        if not value:
            return out


def key(number, wire):
    return varint(number << 3 | wire)


def message(number, payload):
    return key(number, 2) + varint(len(payload)) + payload


def sweep(sweep_id, pose=None, status="success"):
    body = message(1, sweep_id.bytes) + message(2, bytes(16))
    if pose is not None:
        body += message(3, b"".join(key(1, 5) + struct.pack("<f", value) for value in pose))
    body += key(4, 1) + struct.pack("<d", 1792435087.0) + message(14, status.encode()) + message(20, b"CAMERA_MODEL_GAMMA_PSI")
    return message(1 if pose is not None else 7, body)


def cloud(count):
    """A sweep cloud: a ring of points three meters out, normals facing the camera."""
    angles = np.linspace(0, 2 * np.pi, count, endpoint=False)
    return b"".join(message(7, message(5, struct.pack("<9f", 3 * np.cos(a), 3 * np.sin(a), 0, -np.cos(a), -np.sin(a), 0, 0, 0, 0)))
                    for a in angles)


class CaptureExportTests(unittest.TestCase):
    def test_matterport_faces_are_right_handed_cameras(self):
        for forward, right, up in MATTERPORT_FACES:
            np.testing.assert_array_equal(np.cross(forward, up), right)

    def test_sphr_faces_look_where_the_viewer_expects(self):
        # Each source pixel holds the sweep-frame direction it sees; every SPHR pixel must see C.T of its own direction.
        size = 8
        grid = 2 * (np.arange(size) + 0.5) / size - 1
        a, b = np.meshgrid(grid, -grid)
        images = []
        for forward, right, up in MATTERPORT_FACES:
            directions = forward + a[..., None] * right + b[..., None] * up
            images.append(directions / np.linalg.norm(directions, axis=2, keepdims=True))
        for face in range(6):
            source, pixels = sphr_face(images, face)
            expected = CENTERS[face] + a[..., None] * RIGHTS[face] + b[..., None] * UPS[face]
            expected = expected / np.linalg.norm(expected, axis=2, keepdims=True) @ C
            with self.subTest(face=face):
                np.testing.assert_allclose(pixels, expected, atol=1e-12)
                np.testing.assert_array_equal(MATTERPORT_FACES[source][0], C.T @ CENTERS[face])

    def test_manifest_keeps_capture_order_and_sets_aside_unaligned_sweeps(self):
        first, second, failed = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        turn = Rotation.from_euler("z", 30, degrees=True).as_quat().tolist()
        data = sweep(first, [0, 0, 0, 1, 0, 0, 0]) + sweep(failed, status="EOS:Failed to align") + sweep(second, turn + [1.5, -2, 0.1])
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "manifest.mfst"
            path.write_bytes(data)
            aligned, unaligned, camera = read_manifest(path)
        self.assertEqual([s["uuid"] for s in aligned], [first.hex, second.hex])
        self.assertEqual([(s["uuid"], s["status"]) for s in unaligned], [(failed.hex, "EOS:Failed to align")])
        self.assertEqual(camera, "CAMERA_MODEL_GAMMA_PSI")
        np.testing.assert_allclose(aligned[1]["translation"], [1.5, -2, 0.1], atol=1e-6)
        np.testing.assert_allclose(aligned[1]["rotation"], turn, atol=1e-6)

    def test_invalid_pose_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "manifest.mfst"
            path.write_bytes(sweep(uuid.uuid4(), [0, 0, 0, 2, 0, 0, 0]))
            with self.assertRaisesRegex(ValueError, "Invalid pose"):
                read_manifest(path)

    def test_node_pose_maps_the_job_frame_into_the_viewer_frame(self):
        rotation = Rotation.from_euler("zyx", [40, 3, -2], degrees=True)
        position, quaternion = node_pose({"rotation": rotation.as_quat().tolist(), "translation": [1, 2, 3]})
        np.testing.assert_allclose(position, [1, 3, -2])
        for vector in np.random.default_rng(1).normal(size=(5, 3)):
            np.testing.assert_allclose(Rotation.from_quat(quaternion).apply(C @ vector), C @ rotation.apply(vector), atol=1e-12)

    def test_job_folder_is_found_once_and_links_never_count(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            data = root / "upload" / "JOB" / "SweepProcessorData"
            data.mkdir(parents=True)
            (data / "manifest.mfst").write_bytes(b"")
            (data / "linked.jpg").symlink_to("/etc/hosts")
            job = find_job(root / "upload")
            self.assertEqual(job.name, "JOB")
            with self.assertRaises(FileNotFoundError):
                source_file(job, "linked.jpg")
            with self.assertRaises(ValueError):
                source_file(job, "../manifest.mfst")
            second = root / "upload" / "OTHER" / "SweepProcessorData"
            second.mkdir(parents=True)
            (second / "manifest.mfst").write_bytes(b"")
            with self.assertRaisesRegex(ValueError, "found 2"):
                find_job(root / "upload")


    def test_alignment_links_join_sweeps_that_line_of_sight_missed(self):
        sweeps = [{"uuid": "a", "parent": None}, {"uuid": "b", "parent": "a"}, {"uuid": "c", "parent": "b"}]
        nodes = [{"uuid": "scan-000", "neighbors": []}, {"uuid": "scan-001", "neighbors": ["scan-002"]},
                 {"uuid": "scan-002", "neighbors": ["scan-001"]}]
        self.assertEqual(add_alignment_links(nodes, sweeps), [["scan-001", "scan-000"], ["scan-000", "scan-001"]])
        self.assertEqual(len(graph_components(nodes)), 1)

    def test_a_table_top_floor_is_refound_at_the_job_camera_height(self):
        nodes = [{"uuid": f"scan-{index:03d}", "position": {"x": 3.0 * index, "y": 1.5, "z": 0.0},
                  "floorPosition": {"x": 3.0 * index, "y": 0.9 if index == 0 else 0.025, "z": 0.0},
                  "floorEstimate": {"method": "measured-local-plane"}} for index in range(6)]
        rng = np.random.default_rng(2)
        floor = np.column_stack([rng.uniform(-3, 18, 20000), np.zeros(20000), rng.uniform(-3, 3, 20000)])
        table = np.column_stack([rng.uniform(-0.5, 0.5, 2000), np.full(2000, 0.875), rng.uniform(-0.5, 0.5, 2000)])
        points = np.vstack([floor, table])
        self.assertEqual(steady_floors(nodes, points, np.tile([0.0, 1.0, 0.0], (len(points), 1))), ["scan-000"])
        self.assertAlmostEqual(nodes[0]["floorPosition"]["y"], 0.025, places=6)
        self.assertEqual(nodes[0]["floorEstimate"]["method"], "job-camera-height")
        self.assertEqual([node["floorPosition"]["y"] for node in nodes[1:]], [0.025] * 5)

    def test_sweeps_without_depth_are_placed_and_a_job_without_any_is_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            job = Path(folder) / "JOB"
            data = job / "SweepProcessorData"
            data.mkdir(parents=True)
            first, second = uuid.uuid4(), uuid.uuid4()
            (data / f"{first}_sweep_cloud.pb").write_bytes(cloud(25000))
            sweeps = [{"uuid": first.hex, "rotation": [0, 0, 0, 1], "translation": [0, 0, 0]},
                      {"uuid": second.hex, "rotation": [0, 0, 0, 1], "translation": [2, 0, 0]}]
            points, normals, missing = fused_points(job, sweeps)
            self.assertEqual((len(points), missing), (25000, [second.hex]))
            np.testing.assert_allclose(np.sum(normals * -points, axis=1) > 0, True, err_msg="normals face their camera")
            (data / f"{first}_sweep_cloud.pb").unlink()
            with self.assertRaisesRegex(ValueError, "build a panorama tour instead"):
                fused_points(job, sweeps)

    def test_skybox_copies_stand_in_for_missing_512_faces(self):
        with tempfile.TemporaryDirectory() as folder:
            job = Path(folder) / "JOB"
            data = job / "SweepProcessorData"
            data.mkdir(parents=True)
            sweep = {"uuid": uuid.uuid4().hex}
            (data / f"{sweep['uuid']}_512_000.jpg").write_bytes(b"x")
            (data / f"{sweep['uuid']}_skybox1.jpg").write_bytes(b"x")
            self.assertEqual(face_file(job, sweep, 0).name, f"{sweep['uuid']}_512_000.jpg")
            self.assertEqual(face_file(job, sweep, 1).name, f"{sweep['uuid']}_skybox1.jpg")
            with self.assertRaisesRegex(FileNotFoundError, "no cube face 2"):
                face_file(job, sweep, 2)

if __name__ == "__main__":
    unittest.main()
