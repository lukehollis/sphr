---
name: sphr-matterport
description: Convert and verify Matterport E57 exports for SPHR, including aligned 360 cube-face scan nodes, reduced 50k GLB meshes, data-only bootstrap/manifest packages, and browser navigation checks. Use when working with Matterport E57 or zip exports, Matterport scan alignment, SPHR Matterport data packages, mesh repair, or Matterport-like click/next panorama navigation.
argument-hint: [e57 path/slug/title or dataset slug]
allowed-tools: Read Write Glob Bash(ls *) Bash(find *) Bash(rg *) Bash(unzip *) Bash(du *) Bash(wc *) Bash(python3 ../data/pipelines/matterport_e57_to_sphr.py *) Bash(node .agents/scripts/matterport/e57-to-sphr.mjs *) Bash(node .agents/scripts/matterport/verify-dataset.mjs *) Bash(node .agents/scripts/project/validate-bootstrap.mjs *) Bash(node .agents/scripts/project/verify-app.mjs *) Bash(npm run typecheck *) Bash(npm run build *)
agent: sphr-matterport
---

Use this for Matterport E57 imports and existing Matterport package QA.

## Contract

Matterport output is a data package under:

```text
public/datasets/matterport/<slug>/
  bootstrap.json
  manifest.json
  faces/scan-000/face0.jpg ... face5.jpg
  mesh/<slug>-50k.glb
```

Do not add scene-specific runtime code for one Matterport export. The Next viewer loads the package through:

```text
/?config=/datasets/matterport/<slug>/bootstrap.json
```

## Source Prep

Keep source exports outside the app runtime, usually under `../data` from `sphr-next` or `data` from the repo root.

For Matterport E57 zips, extract `cloud_0.e57` to a stable processed source path:

```bash
mkdir -p ../data/processed/<slug>/source
unzip -j ../data/<matterport-export>.zip 'cloud_0.e57' -d ../data/processed/<slug>/source
```

Rename the extracted E57 to `<slug>.e57` when useful for repeatability.

## Conversion

Before converting, ensure the Matterport Python dependencies are installed outside the app runtime:

```bash
python3 -m venv ../.venv-matterport
../.venv-matterport/bin/python -m pip install -r ../data/pipelines/requirements-matterport.txt
```

If using an existing Python environment, set `SPHR_MATTERPORT_PYTHON=/path/to/python`. The wrapper preflights `numpy`, `Pillow`, `pye57`, `open3d`, and `trimesh` before running the converter.

Run the reusable pipeline through the wrapper from `sphr-next`. Paths passed to the wrapper are resolved from the repo root:

```bash
node .agents/scripts/matterport/e57-to-sphr.mjs \
  --e57 data/processed/<slug>/source/<slug>.e57 \
  --slug <slug> \
  --title "<Title>" \
  --target-triangles 50000 \
  --mesh-sample-per-scan 26000 \
  --mesh-max-points 240000 \
  --voxel-size 0.08 \
  --poisson-depth 8
```

Use `--skip-images` when cube faces and nodes already exist and only the mesh/manifest needs regeneration.

Use `--repair-existing-mesh --skip-images` when an existing GLB has valid topology in Trimesh but fails another GLB loader. The repair path rewrites and validates the GLB without changing node/image data.

Use `--mesh-method ball-pivoting` when Open3D Poisson reconstruction fails on an export.

The converter writes node rotations for the production SPHR `EnvCube` convention: the viewer applies `(x, -y, z)` and a fixed 180 degree Z cube basis. Do not compensate by adding scene-specific runtime branches; fix the converter if E57 rotation math is wrong.

## Data Checks

After conversion, run:

```bash
node .agents/scripts/project/validate-bootstrap.mjs public/datasets/matterport/<slug>/bootstrap.json
node .agents/scripts/matterport/verify-dataset.mjs --slug <slug> --url http://localhost:3000 --screenshots
```

When a visible floor marker is available, also run marker-click QA. Prefer automatic marker projection; use manual coordinates only if auto projection cannot find a visible non-active marker:

```bash
node .agents/scripts/matterport/verify-dataset.mjs --slug <slug> --url http://localhost:3000 --screenshots --marker-click auto
```

Expected package properties:

- `nodeCount` equals the E57 scan count.
- Face count equals `nodeCount * 6`.
- Matterport skybox face `0` maps to SPHR top face `0`, and Matterport skybox face `5` maps to SPHR bottom face `5`.
- Matterport top face `0` must be rotated 90 degrees counter-clockwise for SPHR, and Matterport bottom face `5` must be rotated 270 degrees counter-clockwise. The manifest must include `imageManifest.faceTransforms`.
- Pole seams must pass `.agents/scripts/matterport/verify-dataset.mjs`; do not accept screenshots alone for top/bottom cube-face orientation.
- Runtime rotation reconstructs the E57 scan orientation after `three = [e57.x, e57.z, -e57.y]` and the production cube basis.
- `space.type` is `spaces`.
- Each node has six cube faces, a 3D position, a floor marker position, and Matterport source metadata.
- `tour.tour_data.sceneGraph` includes the reduced GLB model.
- The reduced GLB is hidden in FPV at rest with `fpvOpacity: 0`, remains raycastable, and is marked `transitionMesh: true` with `transitionTexture: "cube-render-target"`.
- `space_data.navigationTransition.meshIds` includes the reduced GLB so node-to-node navigation can capture the outgoing panorama with `CubeCamera`, map it onto the mesh, fade it, and restore default materials.
- Mesh manifest reports about 50k triangles.

## Browser Quality Gate

A Matterport import is not done until browser verification shows:

- The config URL loads to an enabled Start button.
- Starting renders the panorama and GLB without failed resources.
- Tour controls are visible and do not overlap.
- Node-to-node navigation works by moving from the first tourpoint to the next and loading the next scan faces.
- In-scene marker clicking works when `--marker-click` is supplied, loads a non-initial scan's cube faces, and enters the cube-render-target mesh transition state.
- Screenshots exist for initial and post-navigation states when `--screenshots` is requested.

Final response should report source export, dataset URL, node/face counts, mesh triangle count, and the browser URL.
