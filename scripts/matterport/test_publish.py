import json
from pathlib import Path
import tempfile
import unittest
import subprocess
from unittest.mock import patch
from publish import commit_catalog, digest, merge_catalog, stage_scene


class PublisherTests(unittest.TestCase):
    def test_concurrent_publication_preserves_the_scene_that_finished_first(self):
        old = {'sceneId': 'aaaaaaaaaaaa', 'title': 'Existing'}
        arriving = {'sceneId': 'bbbbbbbbbbbb', 'title': 'Other publisher'}
        ours = {'sceneId': 'cccccccccccc', 'title': 'This publisher'}
        writes = []
        with tempfile.TemporaryDirectory() as temp:
            index = Path(temp) / 'index.json'

            def upload(*args):
                writes.append((args[-1], json.loads(index.read_text())))
                if len(writes) == 1:
                    raise subprocess.CalledProcessError(1, ['gcloud', 'storage', 'cp'])

            with patch('publish.read_remote_catalog', side_effect=[([old], '10'), ([old, arriving], '11')]), patch('publish.gcloud', upload):
                result = commit_catalog([ours], index, 'gs://bucket/index.json')
        self.assertEqual([generation for generation, _ in writes], ['--if-generation-match=10', '--if-generation-match=11'])
        self.assertEqual({e['sceneId'] for e in result['spaces']}, {old['sceneId'], arriving['sceneId'], ours['sceneId']})

    def test_unchanged_generation_does_not_hide_an_upload_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch('publish.read_remote_catalog', return_value=([], '10')), patch('publish.gcloud', side_effect=subprocess.CalledProcessError(1, ['gcloud'])) as upload:
                with self.assertRaises(subprocess.CalledProcessError):
                    commit_catalog([{'sceneId':'aaaaaaaaaaaa'}], Path(temp)/'index.json', 'gs://bucket/index.json')
            self.assertEqual(upload.call_count, 1)

    def test_merge_preserves_remote_scenes_and_replaces_only_matching_ids(self):
        old={'sceneId':'aaaaaaaaaaaa','title':'Old','createdAt':'2026-01-01'}
        other={'sceneId':'bbbbbbbbbbbb','title':'Remote only','createdAt':'2026-01-02'}
        new=dict(old,title='New')
        merged=merge_catalog([old,other],[new])
        self.assertEqual({e['sceneId']:e['title'] for e in merged},{'aaaaaaaaaaaa':'New','bbbbbbbbbbbb':'Remote only'})
        with self.assertRaises(ValueError): merge_catalog([old,old],[new])

    def test_versions_references_integrity_and_runtime_only_uploads(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); folder=root/'capture'; folder.mkdir()
            (folder/'faces/scan-000').mkdir(parents=True); (folder/'mesh').mkdir()
            face=folder/'faces/scan-000/face0.jpg'; face.write_bytes(b'photo')
            mesh=folder/'mesh/capture-50k.glb'; mesh.write_bytes(b'mesh')
            (folder/'preview.jpg').write_bytes(b'preview')
            (folder/'raw.e57').write_bytes(b'private raw export')
            (folder/'faces/scan-retired').mkdir()
            (folder/'faces/scan-retired/face0.jpg').write_bytes(b'retired image')
            (folder/'mesh/old.glb').write_bytes(b'retired mesh')
            (folder/'bootstrap.json').write_text(json.dumps({'space':{'mesh':'/datasets/matterport/capture/mesh/capture-50k.glb',
                'position':[1,2,3],'faces':['/datasets/matterport/capture/faces/scan-000/face0.jpg']}}))
            manifest={'sceneId':'aaaaaaaaaaaa','slug':'capture','datasetUrl':'/datasets/matterport/capture',
                'imageManifest':{'groups':{'scan-000':{'sourceFaces':[{'sphrFace':0,'sha256':digest(face)}]}}},
                'mesh':{'sha256':digest(mesh)}}
            (folder/'manifest.json').write_text(json.dumps(manifest))
            (folder/'validation.json').write_text('{"passed":true}')
            entry={'sceneId':'aaaaaaaaaaaa','title':'Capture'}
            published,path=stage_scene(folder,entry,'https://static.mused.com/sphr',root/'stage')
            output=root/'stage'/path
            data=json.loads((output/'bootstrap.json').read_text())
            self.assertEqual(data['space']['position'],[1,2,3])
            self.assertTrue(data['space']['mesh'].startswith('https://static.mused.com/sphr/scenes/aaaaaaaaaaaa/'))
            self.assertFalse((output/'raw.e57').exists())
            self.assertFalse((output/'faces/scan-retired').exists())
            self.assertFalse((output/'mesh/old.glb').exists())
            self.assertFalse((output/'manifest.json').exists())
            self.assertEqual(json.loads((folder/'bootstrap.json').read_text())['space']['position'],[1,2,3])
            face.write_bytes(b'damaged photo')
            with self.assertRaisesRegex(ValueError,'Image no longer matches'):
                stage_scene(folder,entry,'https://static.mused.com/sphr',root/'bad')
            manifest['imageManifest']['groups']['scan-000']['sourceFaces'][0]['sha256']=digest(face)
            (folder/'manifest.json').write_text(json.dumps(manifest))
            second,newpath=stage_scene(folder,entry,'https://static.mused.com/sphr',root/'new')
            self.assertNotEqual(path,newpath)
            self.assertEqual(second['sceneId'],published['sceneId'])
            with self.assertRaisesRegex(ValueError,'Invalid scene ID'):
                stage_scene(folder,dict(entry,sceneId='../escape'),'https://static.mused.com/sphr',root/'unsafe')
            (folder/'bootstrap.json').unlink()
            with self.assertRaisesRegex(ValueError,'Missing runtime asset'):
                stage_scene(folder,entry,'https://static.mused.com/sphr',root/'incomplete')


if __name__=='__main__': unittest.main()
