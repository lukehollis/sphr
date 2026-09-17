# SPHR Matterport Imports

- Use the tracked importer in `scripts/matterport` via `npm run import:matterport`.
- Read `docs/matterport.md` for the complete geometry and validation contract.
- Keep raw sources outside public assets and generated packages under `public/datasets/matterport/<slug>`.
- Derive image face order and rotations from image poses and intrinsics, associated by data3D GUID.
- New nodes use a direct quaternion. Never reintroduce the old fixed face permutation or Euler correction: its panoramas could have seamless edges while being rotated 180 degrees relative to geometry.
- Preserve metric coordinates using `[x,z,-y]` for points, cameras, meshes, and floors.
- Fuse measured depth, reduce the mesh to at most the configured 50k triangles, and bake a photo texture atlas from calibrated cameras.
- Infer floors from measured planes and neighbors from unobstructed sightlines. Do not use a fixed camera-height offset or force through-wall connections.
- Publish only after all image/camera, seam, scale, floor, hash, and actual GLB checks pass.
- Measure original-image seam baselines before re-encoding. Report inherited edge differences;
  reject added conversion damage. Do not loosen a global threshold to bless a failed capture.
- Default imports to `tour_data.mode: "explore"`. Only an authored tour enables guided UI.
- Keep the title-only header; dollhouse double-click enters a scan. Do not restore removed controls.
- In FPV, keep the reduced mesh hidden at rest and raycastable. Capture the outgoing panorama once and project it onto the mesh from the fixed scan origin during navigation.
- Await incoming textures, preserve the current panorama on failure, and bound unpinned texture memory.
- Keep scene-specific information in the data package. No bespoke runtime code for individual Matterport exports.
- Do not commit real capture IDs, source filenames, local configurations, or batch reports. Use generic test fixtures and example paths; retain actual receipts in ignored local/external storage.
- Verify actual browser navigation, transitions, overview, poles, stairs, dark scans, mobile controls, and the existing 3DGS demo in addition to automated checks.
