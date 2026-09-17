from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
import numpy as np
import open3d as o3d
from checkpoint import load_inputs, save_inputs, save_surface


class CheckpointTests(unittest.TestCase):
    def test_binds_source_poses_and_measured_geometry_before_resuming(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'export.zip'
            source.write_bytes(b'original checked export')
            args = SimpleNamespace(slug='capture',face_size=2048,depth_size=512,voxel_size=.035,dataset_prefix='/datasets/matterport')
            nodes = [{'uuid':'scan-000','floorPosition':{'x':0,'y':float('nan'),'z':0},'position':{'x':0,'y':1.8,'z':0}}]
            directory = root / 'checkpoint'
            save_inputs(directory,source,args,nodes,{},[],[])
            save_surface(directory,o3d.geometry.TriangleMesh.create_box(),[np.array([[0,0,0]],dtype=np.float32)],[])
            data,_ = load_inputs(directory,source,args)
            self.assertTrue(np.isnan(data['nodes'][0]['floorPosition']['y']))
            self.assertEqual(data['nodes'][0]['position']['y'],1.8)
            source.write_bytes(b'different export')
            with self.assertRaisesRegex(ValueError,'Original export differs'):
                load_inputs(directory,source,args)
            source.write_bytes(b'original checked export')
            (directory/'measured.ply').write_bytes(b'changed mesh')
            with self.assertRaisesRegex(ValueError,'checkpoint content changed'):
                load_inputs(directory,source,args)


if __name__ == '__main__':
    unittest.main()
