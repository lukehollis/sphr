import json
from pathlib import Path
import struct
import tempfile
import unittest

import numpy as np
from scipy.spatial.transform import Rotation

from catalog import write_matterport_index
from web_archive import fields, load_dam, local_asset, pano_quaternion, select_skybox


class WebArchiveTests(unittest.TestCase):
    def test_truncated_wire_records_are_rejected(self):
        for data in [b"\x80", b"\x0a\x05x", b"\x0d\x01", b"\x00"]:
            with self.subTest(data=data), self.assertRaises(ValueError):
                list(fields(data))

    def test_asset_paths_cannot_escape_archive(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "linked").symlink_to("/etc")
            for url in ["https://cdn.example/%2e%2e/secret", "https://cdn.example/linked/hosts"]:
                with self.assertRaises(ValueError):
                    local_asset(root, url)

    def test_locked_higher_resolution_is_never_selected(self):
        pano = {"skyboxes": [{"resolution": "4k", "status": "locked", "urlTemplate": "locked"},
                              {"resolution": "2k", "status": "available", "urlTemplate": "available"}]}
        self.assertEqual(select_skybox(pano)[0]["resolution"], "2k")

    def test_source_basis_includes_showcase_sweep_quarter_turn(self):
        result = Rotation.from_quat(pano_quaternion({"x": 0, "y": 0, "z": 0, "w": 1}))
        np.testing.assert_allclose(result.apply([0, 0, 1]), [1, 0, 0], atol=1e-12)
        with self.assertRaises(ValueError):
            pano_quaternion({"x": 0, "y": 0, "z": 0, "w": 0})

    def test_dam_preserves_uvs_and_rejects_invalid_triangle(self):
        def field(tag, value):
            return bytes([tag * 8 + 2, len(value)]) + value
        vertices = field(1, struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0)) + field(2, struct.pack("<6f", 0, 0, 1, 0, 0, 1))
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "source.dam"
            for index in [2, 3]:
                message = field(1, vertices) + field(2, field(1, bytes([0, 1, index]))) + field(4, b"texture_000.jpg")
                path.write_bytes(field(1, message))
                if index == 2:
                    chunks = load_dam(path)
                    np.testing.assert_array_equal(chunks[0]["faces"], [[0, 1, 2]])
                    np.testing.assert_array_equal(chunks[0]["uv"], [[0, 0], [1, 0], [0, 1]])
                else:
                    with self.assertRaises(ValueError):
                        load_dam(path)

    def test_web_and_e57_packages_coexist_and_keep_ids(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name, schema in [("web", "sphr-matterport-web-v1"), ("e57", "sphr-matterport-e57-v2")]:
                target = root / name
                target.mkdir()
                (target / "bootstrap.json").write_text("{}")
                (target / "manifest.json").write_text(json.dumps({"schema": schema, "slug": name, "title": name,
                    "datasetUrl": f"/datasets/matterport/{name}", "bootstrapUrl": f"/datasets/matterport/{name}/bootstrap.json"}))
            first = write_matterport_index(root)
            self.assertEqual(len(first), 2)
            self.assertEqual(first, write_matterport_index(root))


if __name__ == "__main__":
    unittest.main()
