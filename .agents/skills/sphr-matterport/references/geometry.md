# Geometry and rendering contract

## Coordinates and camera conventions

Every spatial quantity is in meters. The rigid right-handed transform is:

```python
C = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]])
three_point = C @ e57_point
three_scan_rotation = C @ e57_scan_rotation @ C.T
quaternion_xyzw = Rotation.from_matrix(three_scan_rotation).as_quat()
```

E57 source quaternions are `[w,x,y,z]`; Three/SciPy use `[x,y,z,w]`. Pinhole image
forward is negative Z, right/up are +X/+Y, and bitmap rows increase downward. Do not
apply a scan transform again after `read_scan(..., transform=True)`.

SPHR plane order differs from conventional WebGL cubemap file order:

| face | center | image right | image up |
| --- | --- | --- | --- |
| 0 | +Y | −X | −Z |
| 1 | +Z | −X | +Y |
| 2 | −X | −Z | +Y |
| 3 | −Z | +X | +Y |
| 4 | +X | +Z | +Y |
| 5 | −Y | −X | +Z |

`geometry.py` is the executable definition. `camera_face_assignment` compares camera
ray bases with scan-local targets, searches quarter turns, and requires a unique
six-face assignment within tolerance. Unsupported/noncentral cameras must fail
explicitly. Image names and source array order are not geometry identifiers.

The historic fixed permutation joined seams but rotated the panorama 180° relative
to measured points. Check both image adjacency and world registration. Numerical
regressions cover shuffled camera order, arbitrary rotations, invalid cubes, metric
handedness, measured floors and lack of floor evidence.

## Reconstruction and texture

`reconstruct.py` projects nearest measured ranges into six depth maps using the same
camera bases. Only continuous one-pixel sampling holes are filled. TSDF integration
uses measured depth, not a guessed closed hull. Measure source-point distances after
quadric reduction. Open3D's requested triangle count is not guaranteed: record actual
topology, retry boundary weights, and use the tracked QEM fallback if necessary.
Fail before texture baking when the configured ceiling is still unmet.
49,999 triangles satisfies a 50k ceiling. UV splitting can increase
vertex count without increasing triangle count.

`texture.py` selects calibrated cameras by surface angle, distance and ray visibility,
unwraps with xatlas, and bakes photographic texture. Unobserved triangles retain source
vertex-color fallback. Texture coverage is not physical completeness of the capture.

Floors first use measured local planes with two-dimensional support and bounded
extrapolation. Wall stripes and decorative ledges can mimic a plane, so refine every
marker with a downward ray at the source camera footprint on the full fused surface
before decimation. Neighboring scans can supply missing nadir measurements. For steep
passages or a small gap underneath the tripod, fit a two-dimensional measured TSDF
footprint within at most 0.5 m, recording slope, support and residuals. Reject unsupported
extrapolation and separated surfaces. This supports measured ramps and steps without
inventing a fixed camera height. Retain
and flag a valid local plane if the mesh lacks that downward observation. If both
sources lack support, record `floorUnobserved: true` and a null floor position, with
an explicit `unobserved-source-floor` warning. Preserve the original camera and all
photographs. The viewer exposes a sphere at the measured camera position, selectable
directly in first person when visible or from dollhouse. It excludes these camera
points from inferred floor-click targeting; a sphere must never become a fake floor
ring. Preserve measured camera sightlines so an uncertain floor does not strand a
neighboring scan that is reachable only through this camera.
Never replace missing evidence with a standard height. Elevated tripods can legitimately be nearly four meters
above the floor: preserve source camera height and flag it for visual review instead
of imposing a standard tripod offset. Graph edges need camera/floor sightlines. Report disconnected components;
never force through-wall connections just to produce one component.

## Viewer

- `PanoramaLayer`: direct quaternions for new imports; legacy Euler support retained.
  Photograph materials avoid fog/tone mapping. Incoming faces are awaited.
- `TextureCache`: pin active/transition textures; bound unpinned LRU entries; handle
  disposal and rejection. Pinned working sets can exceed the 320 MiB target.
- `SceneGraphLayer`: at-rest mesh hidden in FPV but raycastable; textured overview.
- `SphrRuntime`: capture outgoing cube once; project with direction
  `worldPosition - fixedCaptureOrigin`; fade the projected mesh late in movement.
  Reflection mapping and per-frame cube recapture are incorrect substitutes.
- `NavigationLayer`: measured floor rings, hidden-marker exclusion and occlusion checks.
  Distant/non-neighbor moves use teleport/crossfade instead of flying through walls.
- Dollhouse: fit mesh bounds; double-click enters a suitable scan at eye level;
  cancel stale camera tweens; single-click must not consume the first half of double-click.

## Quality interpretation

Use each capture's receipts. Observatory's measured median/p95 mesh distances
(1.09/7.18 cm) are examples, not universal acceptance thresholds. Exact coordinate
conversion certifies metric handling, not accuracy of every source measurement.
Poor point/photo agreement, unusual floor support, new disconnected areas or large
mesh errors require comparison with source bytes and actual visible results.
