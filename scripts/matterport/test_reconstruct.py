import copy
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
import numpy as np
import open3d as o3d
from reconstruct import Fusion, refine_floors, footprint_floor


def floor_mesh():
    return o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector([[-2,0,-2],[-2,0,2],[2,0,2],[2,0,-2]]),
                                    o3d.utility.Vector3iVector([[0,1,2],[0,2,3]]))


class MeasuredFloorTests(unittest.TestCase):
    def test_missing_source_floor_keeps_the_camera_without_inventing_a_marker(self):
        mesh=floor_mesh()
        mesh.rotate(o3d.geometry.get_rotation_matrix_from_xyz([0,0,np.pi/2]),center=[0,0,0])
        mesh.translate([3,0,0])
        node={'uuid':'scan-000','position':dict(x=0,y=1.8,z=0),
              'floorPosition':dict(x=0,y=float('nan'),z=0),
              'floorEstimate':{'method':'pending-measured-mesh'}}
        reports=[{'floor':node['floorEstimate']}]
        refine_floors([node],reports,mesh)
        self.assertTrue(node['floorUnobserved'])
        self.assertIsNone(node['floorPosition'])
        self.assertEqual(node['position'],dict(x=0,y=1.8,z=0))
        self.assertEqual(reports[0]['floor']['access'],'camera-point')

    def test_measured_sloping_patch_can_bridge_a_small_tripod_gap(self):
        # Four strips leave a 10 cm unobserved square beneath the camera.
        vertices, triangles = [], []
        for x0,x1,z0,z1 in [(-1,-.05,-1,1),(.05,1,-1,1),(-.05,.05,-1,-.05),(-.05,.05,.05,1)]:
            offset=len(vertices)
            vertices.extend([[x, .7*x, z] for x,z in [(x0,z0),(x0,z1),(x1,z1),(x1,z0)]])
            triangles.extend([[offset,offset+1,offset+2],[offset,offset+2,offset+3]])
        mesh=o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(vertices),o3d.utility.Vector3iVector(triangles))
        scene=o3d.t.geometry.RaycastingScene()
        scene.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(mesh))
        level,report=footprint_floor(scene,np.array([0,1.8,0]))
        self.assertAlmostEqual(level,0,places=5)
        self.assertAlmostEqual(report['slope'],.7,places=5)
        self.assertGreaterEqual(report['points'],6)

    def test_marker_uses_surface_under_camera_not_a_nearby_ledge(self):
        nodes=[{'uuid':'scan-000','position':dict(x=0,y=1.9,z=0),
                'floorPosition':dict(x=0,y=1.45,z=0),
                'floorEstimate':{'method':'measured-local-plane','cameraHeight':.45}}]
        reports=[{'floor':copy.deepcopy(nodes[0]['floorEstimate'])}]
        refine_floors(nodes,reports,floor_mesh())
        self.assertAlmostEqual(nodes[0]['floorPosition']['y'],.025,places=6)
        self.assertEqual(reports[0]['floor']['method'],'measured-tsdf-surface')
        self.assertAlmostEqual(nodes[0]['position']['y'],1.9)

    def test_fused_neighbor_observations_can_resolve_missing_local_floor(self):
        nodes=[{'uuid':'scan-000','position':dict(x=0,y=4,z=0),
                'floorPosition':dict(x=0,y=float('nan'),z=0),
                'floorEstimate':{'method':'pending-measured-mesh'}}]
        reports=[{'floor':nodes[0]['floorEstimate']}]
        refine_floors(nodes,reports,floor_mesh())
        self.assertAlmostEqual(nodes[0]['floorEstimate']['cameraHeight'],4)

    def test_finish_reports_real_topology_depth_resolution_and_graph(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary)
            fusion=Fusion(directory,SimpleNamespace(voxel_size=.035,depth_size=512,target_triangles=50000))
            mesh=floor_mesh()
            fusion.volume=SimpleNamespace(extract_triangle_mesh=lambda:mesh)
            node={'uuid':'scan-000','position':dict(x=0,y=1.8,z=0),
                  'floorPosition':dict(x=0,y=0,z=0),'floorEstimate':{'cameraHeight':1.8}}
            fusion.reports=[{'node':'scan-000','floor':node['floorEstimate']}]
            fusion.sampled=[np.array([[0,0,0]],dtype=np.float32)]
            result=fusion.finish([node],directory/'mesh.ply',lambda mesh,path:o3d.io.write_triangle_mesh(str(path),mesh))
            self.assertEqual(result['triangles'],2)
            self.assertEqual(result['depthSize'],512)
            self.assertTrue((directory/'quality.json').exists())


if __name__ == '__main__': unittest.main()
