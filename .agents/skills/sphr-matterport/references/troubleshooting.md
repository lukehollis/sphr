# Failure diagnosis

| Symptom | Evidence and correction |
| --- | --- |
| ZIP cannot open / E57 size mismatch | Check download state, archive CRC and physical header size. Preserve partial source; wait for completion or report missing bytes. |
| Missing Python module | Use importer-selected environment and tracked requirements, including xatlas. Installing in a different Python does not fix it. |
| Image cameras do not form cube | Inspect GUID associations, pose bases and pinhole intrinsics. Do not guess a Skybox permutation or suppress the error. |
| Seam check fails | Compare the same canonical edge in original embedded images and derived JPGs. Source exposure, masking or high-frequency geometry can differ at edges; record a source baseline/warning. Added conversion differences remain failures. |
| Seamless but mesh faces wrong way | Check world point/photo reprojection and quaternion basis. The historic global 180° yaw error passed edge-only checks. |
| Marker floats / wrong floor | Inspect local point support, search radius, plane residual, camera height and nearby scan evidence. Fix generic inference; never add a scene-specific height. |
| Mesh disappears / huge scale | Compare source camera translations, coordinate transform, GLB bounds and scene group transforms. Ensure transform applied once. |
| Mesh has holes | Compare measured depth coverage and source returns before changing fusion. Reflective/dark/unobserved surfaces cannot be recovered by a validator. Distinguish source gaps from failed reconstruction. |
| Overview texture artifacts | Check source-camera visibility, angle selection, UV winding/order, texture color space and atlas coverage; do not relight the panorama to hide geometry errors. |
| Sliding/reflective movement | Check fixed capture-origin projection, not environment reflection. Capture cube once per move; keep destination background behind projected mesh. |
| Black flash / stuck move | Check every incoming image response, prepare rejection, old scene retention, navigation release and disposed async work. |
| Memory grows each move | Check pinned working sets, rejected cache entries and LRU eviction. 4096 faces need much more memory; reducing the cache alone cannot evict active faces. |
| Missing scene after import | Inspect final directory, publication receipt and index; restart owned production server if static routes are stale. Verify exact config URL. |
| Guided button on bare import | Imported waypoints must use `tour_data.mode: "explore"`; don't infer a tour merely from scan count or fallback camera point. |
| Double-click fails in overview | Guided mode must not swallow double-click. Single-click stays in orbit; raycast nearest surface/marker, await images, enter eye-level FPV, cancel old camera tween. |
| Disconnected graph | Compare walls/doors and camera/floor sightlines. Preserve components and allow overview entry; never force a through-wall edge. |

## Safe retry rules

A failure leaves `.slug.building`; the previous published scene should remain intact.
Resolve the cause before retrying. Do not run two writers for one slug. A changed image
calibration requires re-extracting and reconstructing; changed viewer-only code does not.
`--skip-*` is artifact reuse, not a general checkpoint/resume mechanism. Keep source hashes
and original bytes unchanged. Do not edit validation JSON to turn a failure into a pass.

## Recorded real failure

Harvard Robotics scan 001 had an absolute edge RGB difference of 0.13072, exceeding the
old 0.10 threshold. The source embedded image measured 0.12876 on the same edge; the
conversion difference was 0.00196. Other camera/point evidence supported registration.
The general repair records source baselines for every scan and checks added seam error,
while retaining source warnings and strict failure for packages without that evidence.
Regression cases cover inherited error, added damage, absent baseline and malformed values.
