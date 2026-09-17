import json
from pathlib import Path
import tempfile
import unittest

from catalog import matching_capture, scene_identity, title_slug, write_matterport_index


class CatalogTests(unittest.TestCase):
    def test_renamed_download_matches_exact_scan_identities_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = {'slug': 'original', 'sceneId': 'aaaaaaaaaaaa',
                        'imageManifest': {'groups': {
                            'scan-000': {'associatedData3DGuid': 'first'},
                            'scan-001': {'associatedData3DGuid': 'second'}}}}
            (root / 'original').mkdir()
            (root / 'original/manifest.json').write_text(json.dumps(manifest))
            (root / '.original.previous').mkdir()
            (root / '.original.previous/manifest.json').write_text(json.dumps(manifest))
            self.assertEqual(matching_capture(root, {'second', 'first'})['sceneId'], 'aaaaaaaaaaaa')
            self.assertIsNone(matching_capture(root, {'first'}))
            self.assertIsNone(matching_capture(root, {'first', 'different'}))
            (root / 'duplicate').mkdir()
            (root / 'duplicate/manifest.json').write_text(json.dumps(dict(manifest, slug='duplicate')))
            with self.assertRaisesRegex(ValueError, 'multiple catalog identities'):
                matching_capture(root, {'first', 'second'})

    def test_identity_survives_title_and_source_changes(self):
        old = {"title": "Original title", "sourceSha256": "old"}
        old.update(scene_identity(old))
        changed = scene_identity({"title": "Renamed space", "sourceSha256": "new"}, old)
        self.assertEqual(old["sceneId"], changed["sceneId"])
        self.assertTrue(changed["scenePath"].endswith("/renamed-space"))

    def test_slug_is_url_safe(self):
        self.assertEqual(title_slug("Café / Lab & Observatory"), "cafe-lab-observatory")
        self.assertEqual(title_slug("東京"), "space")

    def test_catalog_handles_100_scenes_and_preserves_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for i in range(100):
                folder = root / f"scene-{i}"
                folder.mkdir()
                (folder / "bootstrap.json").write_text("{}")
                (folder / "manifest.json").write_text(json.dumps({
                    "schema": "sphr-matterport-e57-v2", "slug": folder.name,
                    "title": "Same title", "datasetUrl": f"/datasets/matterport/{folder.name}",
                    "bootstrapUrl": f"/datasets/matterport/{folder.name}/bootstrap.json",
                }))
            first = write_matterport_index(root)
            self.assertEqual(len(first), 100)
            self.assertEqual(len({scene["sceneId"] for scene in first}), 100)
            self.assertEqual(first, write_matterport_index(root))
            # A failed duplicate-ID update must leave the published index intact.
            index_before = (root / "index.json").read_bytes()
            file = root / "scene-1/manifest.json"
            duplicate = json.loads(file.read_text())
            duplicate["sceneId"] = json.loads((root / "scene-0/manifest.json").read_text())["sceneId"]
            file.write_text(json.dumps(duplicate))
            with self.assertRaisesRegex(ValueError, "Duplicate"):
                write_matterport_index(root)
            self.assertEqual(index_before, (root / "index.json").read_bytes())
