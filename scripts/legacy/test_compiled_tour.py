import unittest
from copy import deepcopy
from compiled_tour import clean_html, convert, portable_map


class CompiledTourTests(unittest.TestCase):
    def setUp(self):
        self.native = {'space': {'id': 'capture', 'type': 'spaces', 'space_data': {'nodes': [
            {'uuid': 'scan-001', 'matterport': {'guid': 'original-guid'}, 'position': {'x': 1, 'y': 2, 'z': 3},
             'quaternion': [0, 0, 0, 1], 'faces': [f'https://assets.example/f{i}.jpg' for i in range(6)]}]}},
            'tour': {'tour_data': {'sceneGraph': [{'id': 'surface', 'persistent': True, 'file': 'https://assets.example/mesh.glb'}]}}}
        self.source = {'schema': 'sphr-compiled-tour-source-v1', 'sha256': 'source-hash', 'points': [
            {'sweep': 'original-guid', 'mode': 'SWEEP', 'rotation': {'x': 12, 'y': 87, 'z': 0},
             'content': '<span class="old-style">A story</span>', 'image': 'painting.jpg'},
            {'sweep': 'short-location-id', 'mode': 'DOLLHOUSE', 'rotation': {'x': -30, 'y': 80}, 'content': 'Overview'}]}
        self.binding = {'tourId': 'example-tour', 'title': 'Example', 'mediaBase': 'https://assets.example',
                        'nodeAliases': {'short-location-id': 'scan-001'},
                        'sceneGraph': [{'id': 'reconstruction', 'file': 'https://assets.example/model.glb'}],
                        'modelsByStop': {'1': ['reconstruction']}}

    def test_exact_scan_aliases_preserve_measured_geometry_and_authored_order(self):
        before = deepcopy(self.native)
        output, receipt = convert(self.source, self.native, self.binding)
        self.assertEqual(self.native, before)
        self.assertEqual(output['space']['space_data']['nodes'], before['space']['space_data']['nodes'])
        points = output['tour']['tour_data']['spaces'][0]['tourpoints']
        self.assertEqual([p['nodeUUID'] for p in points], ['scan-001', 'scan-001'])
        self.assertEqual(points[0]['rotation'], {'azimuth': 87, 'polar': 12})
        self.assertEqual(points[1]['viewMode'], 'ORBIT')
        self.assertEqual(points[1]['models'], ['surface', 'reconstruction'])
        self.assertEqual(points[0]['files'][0]['url'], 'https://assets.example/painting.jpg')
        self.assertEqual(len(receipt['stops']), 2)

    def test_embedded_map_preserves_location_without_archived_credentials(self):
        result = portable_map('https://www.google.com/maps/embed/v1/place?key=old-key&q=1.25,-2.5&zoom=7&maptype=satellite')
        self.assertIn('q=1.25%2C-2.5', result)
        self.assertIn('z=7&t=k&output=embed', result)
        self.assertNotIn('key', result)
        with self.assertRaisesRegex(ValueError, 'provider'):
            portable_map('https://example.com/maps?q=1,2')

    def test_overrides_cannot_bypass_identity_validation(self):
        self.binding['pointOverrides'] = {'0': {'nodeUUID': 'missing'}}
        with self.assertRaisesRegex(ValueError, 'undefined scan'):
            convert(self.source, self.native, self.binding)

    def test_missing_scans_are_never_replaced_by_nearest_scan(self):
        self.source['points'][0]['sweep'] = 'unrelated-guid'
        with self.assertRaisesRegex(ValueError, 'no exact native match'):
            convert(self.source, self.native, self.binding)

    def test_alias_collision_and_missing_model_are_rejected(self):
        self.binding['nodeAliases']['original-guid'] = 'missing-scan'
        with self.assertRaisesRegex(ValueError, 'Invalid source scan alias'):
            convert(self.source, self.native, self.binding)
        del self.binding['nodeAliases']['original-guid']
        self.binding['modelsByStop']['0'] = ['missing-model']
        with self.assertRaisesRegex(ValueError, 'undefined embedded model'):
            convert(self.source, self.native, self.binding)

    def test_unsupported_camera_pose_fails_instead_of_silently_losing_it(self):
        self.source['points'][0]['rotation']['z'] = 10
        with self.assertRaisesRegex(ValueError, 'camera rotation'):
            convert(self.source, self.native, self.binding)

    def test_legacy_html_preserves_copy_and_safe_links_without_executing_source(self):
        result = clean_html('<span onclick="bad()">Text &amp; detail</span><script>bad()</script>'
                            '<svg><path d="bad"/></svg><a href="javascript:bad()">Unsafe</a>'
                            '<a href="https://example.com/story">Story</a>')
        self.assertIn('<p>Text &amp; detail</p>', result)
        self.assertIn('href="https://example.com/story"', result)
        for removed in ['onclick', 'script', 'javascript:', '<svg', 'bad()']:
            self.assertNotIn(removed, result)


if __name__ == '__main__':
    unittest.main()
