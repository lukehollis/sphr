---
name: sphr-lidar-package
description: Package lidar and scanner outputs other than Matterport (Leica, Faro, NavVis, Trimble, drone LAS/LAZ, iPhone/iPad lidar apps like Polycam and 3D Scanner App) as hosted SPHR spaces, as calibrated panoramas, point-cloud splats or orbitable meshes.
---

# Lidar and scanned-mesh packages

Choose by what the scanner exported:

1. **E57 with panoramic images** (Leica BLK360/RTC360, Faro, NavVis and Matterport all can): the calibrated
   panorama importer gives the best result. Follow the sphr-matterport skill; it works for any E57 whose
   `images2D` are registered to the scans. `inspect-inputs.mjs` reports `images` for each E57.
2. **Point clouds** (LAS/LAZ from drones and mobile mappers, E57 without images, PLY points, PCD, XYZ/PTS):
   ```sh
   node scripts/packages/build-pointcloud.mjs --input "<file>" --title "<title>" [--up z|y] [--max-points 4000000] [--interior] [--elevation 35]
   ```
   Each point becomes a small round splat; up to 4 million points keep phones responsive, thinned on a voxel
   grid. Colors come from the scan's RGB, else intensity, else height. LAS, E57 and text files are usually
   z-up, PLY and PCD y-up; if `preview.jpg` shows the scan on its side, rebuild with the other `--up`.
   Georeferenced coordinates are recentered automatically. Use `--interior` for building interiors.
3. **Meshes** from phone lidar and photogrammetry apps (OBJ with MTL and textures, GLB/glTF, PLY with faces,
   STL, USDZ, FBX, DAE):
   ```sh
   node scripts/packages/build-model.mjs --input "<file>" --title "<title>" [--up y|z] [--max-faces 1500000] [--lit]
   ```
   Keep an OBJ's `.mtl` and texture images in the same folder (unpacked ZIPs already are). USDZ and FBX need
   Blender, which the processing image includes. Textured scans render unlit so the captured lighting shows;
   `--lit` adds lights for plain or vertex-colored meshes. Meshes above 1.5 million faces are simplified.

Several exports of one scan (for example Polycam's GLB, OBJ and point cloud): prefer the textured mesh for
small spaces and objects, the point cloud for large sites. Check `preview.jpg` either way.
