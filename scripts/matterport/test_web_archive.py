import json
import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest import mock

import numpy as np
from PIL import Image
from scipy.spatial.transform import Rotation

from catalog import write_matterport_index
from geometry import C
from publish import stage_scene
from web_archive import TAGS, convert, fields, load_dam, local_asset, pano_quaternion, plain_text, read_glb, select_skybox, source_neighbors


def field(tag, value):
    return bytes([tag * 8 + 2, len(value)]) + value


def tiny_archive(root, tags, floor={"id": "f1"}):
    """One sweep of 512 px faces, a one-triangle DAM with its texture, and the Mattertags the runner saves."""
    template = "https://cdn-2.matterport.com/models/m/assets/pan/512/~/s1_skybox<face>.jpg?t=signed"
    location = {"id": "l1", "index": 0, "neighbors": [], "floor": floor, "position": {"x": 1, "y": 2, "z": 0},
                "pano": {"sweepUuid": "s1", "label": "1", "position": {"x": 1, "y": 2, "z": 1.5}, "rotation": {"x": 0, "y": 0, "z": 0, "w": 1},
                         "skyboxes": [{"resolution": "512", "status": "available", "urlTemplate": template}, {"resolution": "4k", "status": "locked"}]}}
    model = {"id": "Model000001", "locations": [location], "assets": {
        "meshes": [{"status": "available", "format": "dam", "resolution": "50k", "url": "https://cdn-2.matterport.com/models/m/assets/m_50k.dam?t=signed"}],
        "textures": [{"status": "available", "quality": "high", "resolution": "50k",
                      "urlTemplate": "https://cdn-2.matterport.com/models/m/assets/~/tex/m_50k_<texture>.jpg?t=signed"}]}}
    prefetch = {"queries": {"GetModelPrefetch": {"data": {"model": model}}, "GetRootPrefetch": {"data": {"model": {"id": "Model000001", "name": "Room"}}}}}
    (root / "index.html").write_text(f"<script>window.MP_PREFETCHED_MODELDATA = parseJSON({json.dumps(json.dumps(prefetch))});</script>")
    rng = np.random.default_rng(1)
    for face in range(6):
        target = root / f"models/m/assets/pan/512/~/s1_skybox{face}.jpg"
        target.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(rng.integers(0, 255, (512, 512, 3), dtype=np.uint8)).save(target)
    vertices = field(1, struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0)) + field(2, struct.pack("<6f", 0, 0, 1, 0, 0, 1))
    (root / "models/m/assets/m_50k.dam").write_bytes(field(1, field(1, vertices) + field(2, field(1, bytes([0, 1, 2]))) + field(4, b"m_50k_000.jpg")))
    texture = root / "models/m/assets/~/tex/m_50k_000.jpg"
    texture.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rng.integers(0, 255, (64, 64, 3), dtype=np.uint8)).save(texture, quality=80)
    photo = root / "apifs/models/Model000001/images/kiln.jpg"
    photo.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (32, 32), "red").save(photo)
    (root / TAGS).parent.mkdir(parents=True, exist_ok=True)
    (root / TAGS).write_text(json.dumps({"data": {"model": {"mattertags": tags}}}))


class WebArchiveTests(unittest.TestCase):
    def test_unavailable_source_neighbors_require_explicit_recorded_omission(self):
        location = {'neighbors': ['present', 'absent']}
        with self.assertRaisesRegex(ValueError, 'unavailable locations'):
            source_neighbors(location, {'present': 'scan'})
        self.assertEqual(source_neighbors(location, {'present': 'scan'}, True), (['scan'], ['absent']))
        self.assertEqual(source_neighbors({'neighbors': ['present']}, {'present': 'scan'}), (['scan'], []))
        self.assertEqual(location['neighbors'], ['present', 'absent'])

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


    def test_tag_descriptions_keep_their_addresses_as_plain_text(self):
        self.assertEqual(plain_text("[Visit the tour](https://example.com/tour). Or [https://a.example](https://a.example)"),
                         "Visit the tour (https://example.com/tour). Or https://a.example")

    def test_link_archive_converts_to_a_publishable_package_with_tags(self):
        anchor, normal = {"x": 1.0, "y": 2.0, "z": 0.5}, {"x": 0.0, "y": -2.0, "z": 0.0}
        tags = [
            {"id": "kiln", "label": "Kiln", "description": "Fired at [the museum](https://museum.example/kilns).", "color": "#D44441", "enabled": True,
             "mediaType": "photo", "media": "https://cdn-2.matterport.com/apifs/models/Model000001/images/kiln.jpg?t=signed", "anchorPosition": anchor, "stemNormal": normal},
            {"id": "film", "label": "Film", "enabled": True, "mediaType": "video", "media": "https://video.example/watch?v=1", "anchorPosition": anchor},
            {"id": "plain", "label": "", "description": "No title here", "enabled": True, "mediaType": "photo", "media": "http://insecure.example/a.jpg", "anchorPosition": anchor},
            {"id": "hidden", "label": "Hidden", "enabled": False, "anchorPosition": anchor}]
        with tempfile.TemporaryDirectory() as folder:
            # Resolved, as the command line passes them (temporary folders sit behind /var on macOS).
            archive, public = Path(folder).resolve() / "archive", Path(folder).resolve() / "public"
            archive.mkdir()
            tiny_archive(archive, tags)
            with mock.patch.dict(os.environ, {"SPHR_SCENE_ID": "0123456789ab"}):
                result = convert(archive, "customer-test01", "Pottery studio", public)
            package = public / "datasets/matterport/customer-test01"
            self.assertEqual([result["nodes"], result["tags"]], [1, 3], "disabled tags are left out")
            manifest = json.loads((package / "manifest.json").read_text())
            self.assertEqual(json.loads((package / "validation.json").read_text())["passed"], True)
            # The dollhouse carries Matterport's own texture file, not an image encoded again.
            document, blob = read_glb((package / "mesh/customer-test01-50k.glb").read_bytes())
            [image] = document["images"]
            view = document["bufferViews"][image["bufferView"]]
            self.assertEqual(image["mimeType"], "image/jpeg")
            self.assertEqual(blob[view["byteOffset"]:view["byteOffset"] + view["byteLength"]], (archive / "models/m/assets/~/tex/m_50k_000.jpg").read_bytes())
            faces = manifest["imageManifest"]["groups"]["s1"]["sourceFaces"]
            self.assertEqual([face["sphrFace"] for face in faces], list(range(6)))
            bootstrap = json.loads((package / "bootstrap.json").read_text())
            kiln, film, plain = bootstrap["space"]["space_data"]["tags"]
            np.testing.assert_allclose([kiln["position"][key] for key in "xyz"], C @ [1.0, 2.0, 0.5])
            np.testing.assert_allclose([kiln["normal"][key] for key in "xyz"], C @ [0.0, -1.0, 0.0])
            self.assertEqual([kiln["title"], kiln["description"], kiln["color"], kiln["source"]],
                             ["Kiln", "Fired at the museum (https://museum.example/kilns).", "#d44441", "matterport"])
            self.assertEqual(kiln["media"], {"type": "image", "url": "/datasets/matterport/customer-test01/tags/kiln.jpg"}, "a photo Matterport hosts is copied in")
            self.assertEqual(film["media"], {"type": "video", "url": "https://video.example/watch?v=1"}, "media elsewhere keeps its https address")
            self.assertEqual([plain["title"], "media" in plain], ["No title here", False], "and media over plain http is dropped")
            # The publisher ships the faces, the mesh and the copied photo, each checked against the manifest.
            entry = next(item for item in write_matterport_index(public / "datasets/matterport") if item["slug"] == "customer-test01")
            stage = Path(folder).resolve() / "stage"
            staged, relative = stage_scene(package, entry, "https://assets.example", stage)
            shipped = {path.relative_to(stage / relative).as_posix() for path in (stage / relative).rglob("*") if path.is_file()}
            self.assertEqual(shipped, {"bootstrap.json", "preview.jpg", "mesh/customer-test01-50k.glb", "tags/kiln.jpg", *(f"faces/s1/face{face}.jpg" for face in range(6))})

    def test_a_photo_without_a_floor_converts_and_a_failed_conversion_leaves_no_staging(self):
        with tempfile.TemporaryDirectory() as folder:
            archive, public = Path(folder).resolve() / "archive", Path(folder).resolve() / "public"
            archive.mkdir()
            tiny_archive(archive, [], floor=None)
            texture = archive / "models/m/assets/~/tex/m_50k_000.jpg"
            kept = texture.read_bytes()
            texture.unlink()
            with mock.patch.dict(os.environ, {"SPHR_SCENE_ID": "0123456789ab"}), self.assertRaises(FileNotFoundError):
                convert(archive, "customer-test02", "No floor", public)
            self.assertEqual(list((public / "datasets/matterport").iterdir()), [], "a failed run removes its own staging directory")
            texture.write_bytes(kept)
            with mock.patch.dict(os.environ, {"SPHR_SCENE_ID": "0123456789ab"}):
                convert(archive, "customer-test02", "No floor", public)
            bootstrap = json.loads((public / "datasets/matterport/customer-test02/bootstrap.json").read_text())
            self.assertIsNone(bootstrap["space"]["space_data"]["nodes"][0]["sourceFloorId"])


if __name__ == "__main__":
    unittest.main()
