# Matterport E57 → SPHR

The importer is part of this repository. It runs locally and needs no Matterport API,
Django server, tour-specific script, or manual rotation/scale offsets.

## Import

```sh
python3 -m venv .venv-matterport
.venv-matterport/bin/pip install -r scripts/matterport/requirements.txt
npm run import:matterport -- --e57 ~/Downloads/mp_e57_Your-Space_abcdefghijk.zip
npm run dev
```

E57 files and ZIPs containing one E57 are accepted. Wait for the download to finish.
A truncated E57 is rejected by comparing its physical size with the file header.
The importer checks ZIP CRCs during extraction. Use `SPHR_MATTERPORT_PYTHON` for an
existing environment. Source paths are relative to the terminal's working directory.

Optional arguments:

```sh
npm run import:matterport -- --e57 /captures/cloud_0.e57 \
  --slug my-space --title "My Space" \
  --target-triangles 50000 --voxel-size 0.035 --depth-size 512 --face-size 2048
```

`--face-size 4096` retains the full resolution of a typical Matterport export.
2048 is the default balance of photographic detail, download size, and GPU memory.
The original source remains unchanged. `--skip-images` or `--skip-mesh` reuses only
an already published v2 package with a matching source SHA-256.

The homepage is the searchable scene collection; `/library` redirects there. Imports
receive permanent `/s/<sceneId>/<title-slug>` links and copy-link controls. See
[collection and hosting](scene-library.md). An explicit URL always selects its own scene:

```
/?config=/datasets/matterport/my-space/bootstrap.json
/?demo=garden
```

## Package

```
public/datasets/matterport/my-space/
  bootstrap.json       # Standard SPHR scene and generated exploration waypoints
  manifest.json        # Source hash, image calibration, conversion settings, mesh counts
  quality.json         # Per-scan photo registration, measured floors, mesh distances, graph
  validation.json      # All-scan camera, seam, scale, asset, and GLB checks
  preview.jpg
  faces/scan-000/face0.jpg … face5.jpg
  mesh/my-space-50k.glb
```

These generated assets are ignored by Git. Publish the package with the app or put
it on a static host and update its asset URLs. The importer builds in a staging
folder, validates the complete result, and then swaps it into place. A failed build
leaves the previously published package intact. One previous version is retained
in `.my-space.previous` beside the published directory.

## Geometry contract

Coordinates are meters, with the right-handed transform `three = [e57.x, e57.z, -e57.y]`.
Points, cameras, floors, and meshes all use the same rigid transform; there is no
independent mesh scale or tour-specific offset.

The six camera images are associated using `associatedData3DGuid`. The importer
uses each image's pose, focal length, pixel size, and principal point to determine
its face and quarter-turn rotation. Names such as `Skybox 0` and file order are not
geometry. Noncentral or non-cube image sets fail with an explicit error.

New nodes have a direct `[x,y,z,w]` quaternion. Older nodes retain their original
SPHR Euler convention. For the observed Matterport camera convention, the old
fixed mapping produced a 180-degree yaw mismatch even when the cube's seams joined.
A seam-only test cannot detect this error. The v2 importer also reprojects measured
point RGB into the photos for every scan and compares the camera ray bases.

The implementation follows the [E57 coordinate system](https://e57-3d-imgfmt.sourceforge.net/bestCoordinates.html)
and [pinhole metadata](https://asmaloney.github.io/libE57Format-docs/dd/d7a/structe57_1_1_pinhole_representation.html).
E57 cameras look along negative Z; image rows run downward in the decoded bitmap.

Measured ranges are projected into six depth cameras and fused with Open3D's
[TSDF integration](https://www.open3d.org/docs/release/tutorial/pipelines/rgbd_integration.html).
Unknown range pixels stay unknown. Only one-pixel holes surrounded by continuous
measured depth are filled. The resulting mesh is quadric-decimated to the configured
triangle budget. A 4096² photo atlas is baked from visible calibrated cameras; unobserved back-facing triangles retain source vertex colors. Use `--atlas-size` to change its resolution.
The mesh supports spatial transitions, raycasting, and a cutaway overview. It cannot
recover surfaces absent from the source depth measurements.

Floor markers come from measured local planes. The search expands when a dark floor
has no nearby depth, using the heights of already measured scans as a capture-specific
prior. Connection candidates must have unobstructed camera and floor sightlines.
Disconnected components are reported, and scans remain accessible through the
dollhouse. The importer never forces a through-wall edge to join components.

## Viewer behavior

- Waits for all incoming panorama faces before moving; keeps the current scene on failure.
- Preserves viewing direction when clicking a location.
- Uses an LRU texture cache with pinned active/transition textures and a 320 MiB target.
  Pinned working sets can temporarily exceed the target, particularly with 4096 images.
- Projects the outgoing cube capture onto the mesh from the fixed source camera origin.
- Captures the transition cube once per move, rather than six extra renders every frame.
- Renders panorama photographs without fog, exposure changes, or a screen vignette.
- Ignores hidden markers for hit testing and filters occluded navigation targets.
- Double-click a dollhouse surface or marker to enter the nearest scan in first person;
  double-click empty background to return to the current scan. Both use the same eased
  camera duration as zooming out, retaining the mesh until a late blend into the photograph.
  Works in guided and free modes. Navigation is silent; failed loads still display an error.
- Retains generic tours, annotations, audio, meshes, IIIF, and Gaussian splats.

Imports set `tour.tour_data.mode` to `"explore"`: scan waypoints support navigation,
but do not advertise a guided tour. Free exploration opens automatically without an intro screen or a tour toggle
or Previous/Next controls. An authored tour with nonempty `spaces[].tourpoints` enables
guided controls unless its mode is explicitly `"explore"`. Use `"guided"` (or omit mode)
when supplying a real tour. Missing and empty tours always use free exploration.

## Verification

```sh
npm run typecheck
npm run build
npm run test:matterport -- public/datasets/matterport/my-space
# Optional: re-bind validation directly to the original E57's bytes and camera poses.
.venv-matterport/bin/python scripts/matterport/validate.py \
  public/datasets/matterport/my-space --source /captures/cloud_0.e57
node .agents/scripts/matterport/verify-dataset.mjs --slug my-space \
  --url http://localhost:3000 --screenshots --marker-click auto
```

The package validator checks every scan and all twelve cube edges, checks image
hashes and source camera bases independently, verifies metric positions, and reads
actual GLB topology. `quality.json` also reports point-to-mesh distances and disconnected
navigation components. Browser review must cover marker navigation, returning from
overview, poles and mobile controls. Check guided Next/Previous when an authored tour
exists, and dark scans or stairs when present. Shared viewer changes also require the
3DGS demo and authored-tour regressions.
Imports always perform source-bound validation before publication. Subsequent standalone
validation checks package integrity; pass `--source` to repeat source-bound checks.

New imports also record edge measurements from the original embedded images. Validation
rejects conversion-induced seam differences while reporting inherited source-edge warnings.
This distinguishes a calibration error from source exposure, masks, or high-frequency edge
content. Older packages without baselines retain the strict absolute seam checks.

The comprehensive agent workflow, roles, troubleshooting and executable examples are in
[the local Matterport skill](../.agents/skills/sphr-matterport/SKILL.md).

Keep each real capture's import command, measured results, and image-seam investigation
with its local migration receipts. Capture reports and generated configurations stay
outside the distributable repository.
