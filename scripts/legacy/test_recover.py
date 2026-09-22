import copy
import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import sys
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location('recover', Path(__file__).with_name('recover.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
sys.modules['recover'] = r
hosted_spec = importlib.util.spec_from_file_location('hosted', Path(__file__).with_name('audit-hosted.py'))
hosted = importlib.util.module_from_spec(hosted_spec)
hosted_spec.loader.exec_module(hosted)
validation_spec = importlib.util.spec_from_file_location('recovery_validation', Path(__file__).with_name('validate.py'))
validation = importlib.util.module_from_spec(validation_spec)
validation_spec.loader.exec_module(validation)
publish_spec = importlib.util.spec_from_file_location('recovery_publish', Path(__file__).with_name('publish.py'))
publisher = importlib.util.module_from_spec(publish_spec)
publish_spec.loader.exec_module(publisher)


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
    def test_hosted_entries_cannot_validate_or_publish(self):
        for space in [
            {'type': 'matterport', 'space_data': {}},
            {'type': 'spaces', 'src': 'https://my.matterport.com/show/?m=Example', 'space_data': {}},
        ]:
            for bootstrap in [
                {'space': space},
                {'space': {'type': 'spaces', 'space_data': {}}, 'orderedSpaces': [space]},
            ]:
                with self.assertRaisesRegex(ValueError, 'native capture'):
                    validation.required_urls(bootstrap, {})
                with self.assertRaisesRegex(ValueError, 'native capture'):
                    r.assert_native_bootstrap(bootstrap)

    def test_publisher_rejects_even_hash_validated_hosted_packages(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); folder = root / 'space-1'; folder.mkdir()
            entry = {'sceneId': '111111111111'}
            (folder / 'bootstrap.json').write_text(json.dumps({'space': {'type': 'spaces'},
                'orderedSpaces': [{'type': 'matterport', 'src': 'https://my.matterport.com/show/?m=Example'}]}))
            (folder / 'preview.jpg').write_bytes(b'preview')
            (folder / 'manifest.json').write_text(json.dumps(entry))
            files = {name: publisher.common.digest(folder / name) for name in ('bootstrap.json', 'preview.jpg')}
            (folder / 'validation.json').write_text(json.dumps({'passed': True, 'files': files}))
            with self.assertRaisesRegex(ValueError, 'native capture'):
                publisher.stage_scene(folder, entry, 'https://assets.example.com', root / 'stage')
            self.assertFalse(list((root / 'stage').rglob('bootstrap.json')))

    def test_cli_audits_hosted_sources_without_generating_embed_packages(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); export = root / 'export.json'; inv = root / 'inventory.txt'; inv.write_text('')
            source = {**record(), 'space_custom': '', 'space_type': 'matterport',
                      'src': 'https://my.matterport.com/show/?m=Example', 'space_data': {}}
            export.write_text(json.dumps({'spaces': [source], 'tours': []}))
            argv = ['recover.py', '--export', str(export), '--inventory', str(inv), '--namespace', 'example',
                    '--out', str(root / 'output'), '--origin', 'https://assets.example.com',
                    '--iiif-origin', 'https://images.example.com']
            with patch.object(sys, 'argv', argv), patch.object(r, 'prepare_preview') as preview:
                with self.assertRaisesRegex(ValueError, 'Native captures are required'):
                    r.main()
                preview.assert_not_called()
            self.assertFalse(list((root / 'output').rglob('bootstrap.json')))
            report = json.loads((root / 'output/audit.json').read_text())
            self.assertEqual(report['pendingNativeCaptures'][0]['id'], 1)

    def test_asset_cors_is_checked_for_the_selected_viewer(self):
        viewer = 'https://viewer.example.com'
        for asset, cors, expected in [
            ('https://assets.example.com/a.jpg', viewer, True),
            ('https://assets.example.com/a.jpg', '*', True),
            ('https://assets.example.com/a.jpg', 'https://other.example.com', False),
            ('https://assets.example.com/a.jpg', None, False),
            (viewer + '/a.jpg', None, True),
        ]:
            response = MagicMock()
            response.__enter__.return_value = response
            response.status = 200
            response.headers = {'Content-Length': '42', 'Content-Type': 'image/jpeg', 'Access-Control-Allow-Origin': cors}
            with patch.object(validation, 'urlopen', return_value=response) as request:
                result = validation.inspect_url(asset, viewer)
            self.assertEqual(request.call_args.args[0].get_header('Origin'), viewer)
            self.assertEqual('error' not in result, expected, result)

    def test_hosted_prefetch_parses_data_without_running_source_scripts(self):
        value = {'queries': {'GetModelPrefetch': {'data': {'model': {'id': 'model', 'locations': []}}}}}
        self.assertEqual(hosted.prefetched_model('window.MP_PREFETCHED_MODELDATA=' + json.dumps(value) + ';')['id'], 'model')
        self.assertEqual(hosted.prefetched_model('window.MP_PREFETCHED_MODELDATA=parseJSON(' + json.dumps(json.dumps(value)) + ');')['id'], 'model')
        value['queries']['GetModelPrefetch']['data']['model'] = None
        self.assertIsNone(hosted.prefetched_model('window.MP_PREFETCHED_MODELDATA=' + json.dumps(value)))
        with self.assertRaisesRegex(ValueError, 'No prefetched'):
            hosted.prefetched_model('<html>temporary error</html>')

    def recover(self, rec=None, inv=None, log=None):
        return r.recover_space(rec or record(), inv if inv is not None else inventory(), 'https://assets.example.com', 'https://images.example.com', log if log is not None else audit())

    def test_cli_stops_before_assets_when_custom_behavior_is_unreviewed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); export = root / 'export.json'; inv = root / 'inventory.txt'; inv.write_text('')
            export.write_text(json.dumps({'spaces': [{**record(), 'space_custom': 'customExperience'}], 'tours': []}))
            argv = ['recover.py', '--export', str(export), '--inventory', str(inv), '--namespace', 'example',
                    '--out', str(root / 'output'), '--origin', 'https://assets.example.com',
                    '--iiif-origin', 'https://images.example.com']
            with patch.object(sys, 'argv', argv), patch.object(r, 'recover_space') as recover:
                with self.assertRaisesRegex(ValueError, 'Source custom handlers'):
                    r.main()
                recover.assert_not_called()
            report = json.loads((root / 'output/audit.json').read_text())
            self.assertFalse(report['customizationsComplete'])
            self.assertEqual(report['customizations'][0]['handler'], 'customExperience')
            export.write_text(json.dumps({'spaces': [record()], 'tours': []}))
            with patch.object(sys, 'argv', argv):
                with self.assertRaisesRegex(ValueError, 'export omits customization metadata'):
                    r.main()

    def test_source_custom_handler_is_not_silently_discarded(self):
        rec = record(); rec['space_custom'] = 'authoredExperience'
        space = self.recover(rec)
        self.assertEqual(space['space_custom'], 'authoredExperience')
        tour = {'id': 3, 'title': 'Example story', 'space_custom': 'customStory', 'space_ids': [1],
                'tour_data': {'spaces': [{'id': 1, 'tourpoints': [{'nodeUUID': 'frame'}]}]}}
        recovered = r.recover_tour(tour, {'1': rec}, {'1': space}, audit())
        self.assertEqual(recovered['tour']['space_custom'], 'customStory')

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
        self.assertEqual(result['tour']['tour_data']['spaces'][0]['tourpoints'][0]['fov'], 110)

    def test_authored_zoom_preserves_original_vertical_fov(self):
        rec = {'id': 4, 'title': 'Example story', 'space_ids': [1], 'tour_data': {
            'spaces': [{'id': 1, 'tourpoints': [{'nodeUUID': 'frame', 'zoom': 30}]}]}}
        result = r.recover_tour(rec, {'1': record()}, {'1': self.recover()}, audit())
        self.assertEqual(result['tour']['tour_data']['spaces'][0]['tourpoints'][0]['fov'], 80)

    def test_urls_preserve_escaped_paths(self):
        self.assertEqual(r.canonical_urls('https://old.example.com/sounds/a%20b c.mp3'), 'https://old.example.com/sounds/a%20b%20c.mp3')
        mapped = r.canonical_urls({'audio': ['https://old.example.com/sounds/a%20b c.mp3', 'https://old.example.com.evil.test/file.jpg']},
                                  {'https://old.example.com': 'https://new.example.com'})
        self.assertEqual(mapped, {'audio': ['https://new.example.com/sounds/a%20b%20c.mp3', 'https://old.example.com.evil.test/file.jpg']})
        with self.assertRaises(ValueError): r.asset_url('http://unsafe.example/a', 'https://assets.example.com')

    def test_inventory_retains_zero_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            p = Path(temp) / 'inventory.txt'; p.write_text('  0 2026-01-01T00:00:00Z gs://bucket/empty.jpg\n  42 2026-01-01T00:00:00Z gs://bucket/ok.jpg\n')
            self.assertEqual(r.read_inventory([p]), {'empty.jpg': 0, 'ok.jpg': 42})

    def test_verified_native_archive_retains_identity_and_rewrites_only_its_assets(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); package = root / 'package'; package.mkdir()
            native = {'space': {'type': 'spaces', 'mesh': '/datasets/example/mesh.glb', 'space_data': {
                'initialNode': 'camera', 'nodes': [{'uuid': 'camera', 'sourceLocationId': 'sweep', 'faces': ['/datasets/example/face.jpg'] * 6}]}},
                'tour': {'tour_data': {'sceneGraph': [{'id': 'mesh', 'file': '/datasets/example/mesh.glb', 'persistent': True}]}}}
            (package / 'bootstrap.json').write_text(json.dumps(native)); (package / 'mesh.glb').write_bytes(b'mesh'); (package / 'face.jpg').write_bytes(b'face')
            assets = [{'path': p.name, 'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(package.iterdir())]
            (package / 'manifest.json').write_text(json.dumps({'schema': 'sphr-matterport-web-v1', 'modelId': 'Example',
                'sourceSha256': 'source', 'datasetUrl': '/datasets/example', 'assets': assets}))
            (package / 'validation.json').write_text(json.dumps({'valid': True, 'sourceVerified': True}))
            spaces = {'1': {'id': 1, 'title': 'Original title', 'type': 'matterport', 'src': 'https://my.matterport.com/show/?m=Example', 'space_data': {}}}
            log = audit(); r.attach_native_archive(package, spaces, 'https://assets.example.com/archives', root / 'stage', log)
            self.assertEqual(spaces['1']['id'], 1); self.assertEqual(spaces['1']['title'], 'Original title')
            self.assertEqual(spaces['1']['type'], 'spaces'); self.assertNotIn('src', spaces['1'])
            self.assertTrue(spaces['1']['mesh'].startswith('https://assets.example.com/archives/'))
            self.assertEqual(spaces['1']['mesh'], spaces['1']['space_data']['sceneGraph'][0]['file'])
            self.assertEqual(sorted(p.name for p in (root / 'stage').rglob('*') if p.is_file()), ['face.jpg', 'mesh.glb'])
            source = {'1': {'id': 1, 'space_type': 'matterport', 'src': 'https://my.matterport.com/show/?m=Example'}}
            tour = {'id': 2, 'title': 'Tour', 'space_ids': [1], 'tour_data': {'spaces': [{'id': 1, 'tourpoints': [{'nodeUUID': 'sweep', 'viewMode': 'DOLLHOUSE'}]}]}}
            recovered = r.recover_tour(tour, source, spaces, log)
            self.assertEqual(recovered['tour']['tour_data']['spaces'][0]['tourpoints'][0]['nodeUUID'], 'camera')
            self.assertEqual(recovered['tour']['tour_data']['spaces'][0]['tourpoints'][0]['viewMode'], 'ORBIT')
            (package / 'face.jpg').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'manifest'):
                r.attach_native_archive(package, {'1': {'type': 'matterport', 'src': source['1']['src']}}, 'https://assets.example.com/archives', root / 'stage', log)


if __name__ == '__main__': unittest.main()
