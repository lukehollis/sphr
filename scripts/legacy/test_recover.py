import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('recover', Path(__file__).with_name('recover.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


def record(id=1):
    return {'id': id, 'title': 'Example capture', 'space_type': 'spaces', 'version': 'v2', 'mesh': 'meshes/example.glb',
            'space_data': {'initialNode': 'frame', 'nodes': [{'uuid': 'frame', 'position': {'x': 1, 'y': 2, 'z': 3},
            'rotation': {'x': .1, 'y': .2, 'z': .3}, 'image': 'wrong.jpg'}],
            'sceneSettings': {'nodes': {'offsetRotation': {'x': 90, 'y': 0, 'z': 0}},
                              'dollhouse': {'offsetRotation': {'x': 1.57, 'y': .2, 'z': 0}, 'scale': 2}}}}


def inventory():
    return {f'spaceshare/frame_face{i}_v2_1024.jpg': 200 for i in range(6)}


def audit():
    return {'repairs': [], 'unavailableNodes': []}


class RecoveryTests(unittest.TestCase):
    def recover(self, rec=None, inv=None, log=None):
        return r.recover_space(rec or record(), inv if inv is not None else inventory(), 'https://assets.example.com', 'https://images.example.com', log if log is not None else audit())

    def test_cube_order_version_and_original_transforms(self):
        original = record()
        out = self.recover(original)
        node = out['space_data']['nodes'][0]
        self.assertEqual(node['position'], original['space_data']['nodes'][0]['position'])
        self.assertEqual(node['rotation'], original['space_data']['nodes'][0]['rotation'])
        self.assertNotIn('image', node)
        self.assertEqual(node['faces'], [f'https://assets.example.com/spaceshare/frame_face{i}_v2_1024.jpg' for i in range(6)])
        self.assertEqual(out['space_data']['sceneSettings']['nodes']['offsetRotation']['x'], 90)
        self.assertEqual(out['space_data']['sceneGraph'][0]['rotation'], [1.57, .2, 0])
        self.assertEqual(out['space_data']['sceneGraph'][0]['scale'], 2)
        self.assertIn('image', original['space_data']['nodes'][0])

    def test_full_face_fallback_keeps_exact_version(self):
        inv = inventory(); del inv['spaceshare/frame_face3_v2_1024.jpg']; inv['spaceshare/frame_face3_v2.jpg'] = 900
        node = self.recover(inv=inv)['space_data']['nodes'][0]
        self.assertEqual(node['faces'][3], 'https://images.example.com/spaceshare/frame_face3_v2.jpg/full/1024,/0/default.jpg')

    def test_empty_or_wrong_version_is_unavailable(self):
        inv = inventory(); inv['spaceshare/frame_face3_v2_1024.jpg'] = 0; inv['spaceshare/frame_face3_1024.jpg'] = 900
        rec = record(); rec['space_data'].pop('initialNode'); log = audit()
        out = self.recover(rec, inv, log)
        self.assertEqual(out['space_data']['nodes'], [])
        self.assertTrue(out['space_data']['noPanos'])
        self.assertEqual(log['unavailableNodes'][0]['missingFaces'], [3])
        with self.assertRaisesRegex(ValueError, 'Initial panorama'):
            self.recover(inv=inv)

    def test_mesh_only_uses_real_source_glb(self):
        rec = record(); rec['mesh'] = ''; rec['source_data'] = 'source_data/example.glb'; rec['space_data'] = {}
        out = self.recover(rec, {})
        self.assertTrue(out['space_data']['noPanos'])
        self.assertTrue(out['mesh'].endswith('/source_data/example.glb'))

    def test_tour_resolves_wrong_id_using_all_panorama_references(self):
        records = {'1': record(), '2': {**record(2), 'space_data': {'nodes': [{'uuid': 'elsewhere'}]}}}
        segment = {'id': 2, 'tourpoints': [{'nodeUUID': 'frame'}]}
        self.assertEqual(r.resolve_tour_space(segment, records, []), '1')
        records['2']['space_data']['nodes'] = [{'uuid': 'frame'}]
        with self.assertRaisesRegex(ValueError, 'uniquely'):
            r.resolve_tour_space(segment, records, [])

    def test_model_stops_do_not_reinterpret_node_as_camera(self):
        rec = {'id': 4, 'title': 'Example story', 'space_ids': [1], 'tour_data': {
            'sceneGraph': [{'id': 'object', 'type': 'model', 'file': 'https://assets.example.com/object.glb'}],
            'spaces': [{'id': 1, 'tourpoints': [{'targetType': 'MODEL', 'nodeUUID': 'absent', 'models': []}]}]}}
        result = r.recover_tour(rec, {'1': record()}, {'1': self.recover()}, audit())
        self.assertEqual(result['tour']['tour_data']['spaces'][0]['tourpoints'][0]['models'], ['object'])
        self.assertEqual(result['tour']['tour_data']['spaces'][0]['tourpoints'][0]['nodeUUID'], 'absent')

    def test_urls_preserve_escaped_paths(self):
        self.assertEqual(r.canonical_urls('https://static.mused.org/sounds/a%20b c.mp3'), 'https://static.mused.com/sounds/a%20b%20c.mp3')
        with self.assertRaises(ValueError): r.asset_url('http://unsafe.example/a', 'https://assets.example.com')

    def test_inventory_retains_zero_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            p = Path(temp) / 'inventory.txt'; p.write_text('  0 2026-01-01T00:00:00Z gs://bucket/empty.jpg\n  42 2026-01-01T00:00:00Z gs://bucket/ok.jpg\n')
            self.assertEqual(r.read_inventory([p]), {'empty.jpg': 0, 'ok.jpg': 42})


if __name__ == '__main__': unittest.main()
