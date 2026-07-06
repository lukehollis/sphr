# SPHR Next Agent Guide

## What This Is

`sphr-next` is the standalone Next.js replacement for the old webpack/Django-rendered SPHR frontend. It does not require Django to render scenes.

Django can still be used as an optional CMS/admin/API source, but the viewer runs from:

- bundled demo data and assets
- a `?config=/path/to/config.json` bootstrap file
- embedded `<script id="space_data" type="application/json">` / `tour_data` / `ordered_spaces_data`
- `window.__SPHR_BOOTSTRAP__`

## First Run

```bash
cd sphr-next
npm install
npm run dev
```

Open the printed localhost URL. The default scene is the Garden Gaussian Splat demo from `garden_splats`, loaded through Spark (`@sparkjsdev/spark`).

Production checks:

```bash
npm run typecheck
npm run build
```

## Important Files

- `components/SphrApp.tsx` wires React UI to the Three runtime.
- `lib/three/SphrRuntime.ts` owns Three, Spark, camera controls, tour navigation, loading, audio, and pointer navigation.
- `lib/three/renderers/SparkSplatLayer.ts` loads 3DGS assets using Spark `SparkRenderer` + `SplatMesh`.
- `lib/three/renderers/PanoramaLayer.ts` renders 360 image nodes as equirectangular spheres or six-face cube panos.
- `lib/three/renderers/IiifImageLayer.ts` renders IIIF images as inspectable Three planes.
- `lib/bootstrap.ts` normalizes old `ss`/backend/garden tour data into the runtime shape.
- `public/demo/garden_demo.spark.splat` and `public/demo/garden_scene_splats_tour.jpg` are the default demo assets.
- `scripts/convert-legacy-splat.mjs` converts older GaussianSplats3D compressed `.splat`/`.ksplat` containers into Spark-readable standard `.splat` rows.
- `.claude/` contains SPHR-specific agent, skill, hook, rule, and helper-script workflows for 3DGS, 360 images, IIIF, animated tours, VFX, and verification.

## Agent Workflow

The `.claude` setup mirrors the product workflow:

- `sphr-project` inspects state, configs, assets, and local URLs.
- `sphr-3dgs` integrates Spark splats and legacy splat conversion.
- `sphr-360` builds panorama node/tour scenes.
- `sphr-iiif` builds IIIF image scenes.
- `sphr-tour` handles animated guided-tour behavior.
- `sphr-vfx` handles scene effects, annotations, model visibility, and polish.
- `sphr-verify` runs type/build/browser verification.
- `sphr-matterport` converts Matterport E57 exports into data-only SPHR packages with aligned 360 nodes and reduced GLB meshes.

Useful helpers:

```bash
node .claude/scripts/project/sphr-state.mjs
node .claude/scripts/project/asset-inventory.mjs
node .claude/scripts/project/validate-bootstrap.mjs
node .claude/scripts/project/verify-app.mjs --url http://localhost:3000 --screenshots
node .claude/scripts/matterport/e57-to-sphr.mjs --e57 data/processed/<slug>/source/<slug>.e57 --slug <slug> --title "<Title>"
node .claude/scripts/matterport/verify-dataset.mjs --slug <slug> --url http://localhost:3000 --screenshots
```

## Data Shape

Use this bootstrap shape for new workflows:

```json
{
  "space": {
    "id": "space-id",
    "title": "Space Title",
    "type": "splat",
    "space_data": {
      "initialPosition": { "x": 0, "y": 1.5, "z": 4 },
      "initialRotation": { "azimuth": 0, "polar": 0 },
      "splats": [{ "id": "main", "url": "/demo/garden_demo.spark.splat", "lod": true }]
    }
  },
  "tour": {
    "title": "Tour Title",
    "tour_data": {
      "spaces": [{ "id": "space-id", "tourpoints": [] }]
    }
  }
}
```

For 360 tours, set `space.type` to `spaces` and provide `space_data.nodes`. Nodes can use `image` for an equirectangular 360 image, explicit `faces`/`cubeFaces`, or a `textureTemplate` with `{uuid}`, `{face}`, and `{resolution}`.

For Matterport imports, use the reusable pipeline in `../data/pipelines/matterport_e57_to_sphr.py` through `.claude/scripts/matterport/e57-to-sphr.mjs`. The generated package lives at `public/datasets/matterport/<slug>` and is loaded with `?config=/datasets/matterport/<slug>/bootstrap.json`.

The Matterport converter is a Python pipeline, not a Django dependency. Install its isolated dependencies with `python3 -m venv ../.venv-matterport` and `../.venv-matterport/bin/python -m pip install -r ../data/pipelines/requirements-matterport.txt`, or set `SPHR_MATTERPORT_PYTHON=/path/to/python` before running `.claude/scripts/matterport/e57-to-sphr.mjs`.

Matterport node rotations are generated for the production SPHR cube-pano convention used by `ss`/`sphr-backend`: the runtime applies `(x, -y, z)` and a fixed 180 degree Z cube basis. If orientation looks wrong, fix the E57 converter and regenerate the package instead of adding a scene-specific runtime workaround.

Matterport cube faces must be emitted in SPHR-ready orientation. The verified transform is: skybox `0` to SPHR top face `0` rotated 90 degrees counter-clockwise, skybox `4` to front, skybox `1` to left, skybox `2` to back, skybox `3` to right, and skybox `5` to bottom face `5` rotated 270 degrees counter-clockwise. The manifest records this as `imageManifest.faceTransforms`.

Matterport QA must include the pole seam check and browser marker navigation:

```bash
node .claude/scripts/matterport/verify-dataset.mjs --slug <slug> --url http://localhost:3000 --marker-click auto
```

For IIIF image scenes, set `space.type` to `iiif` with `space.src`, or provide `space_data.iiif`.

## Adapting Workflows

Keep new scene-specific behavior data-driven where possible:

- Use tour point `position`, `rotation`, `zoom`, `viewMode`, and `targetType` for camera motion.
- Use `models` to show GLB scene graph objects.
- Use `annotations` to show annotation planes.
- Use `sounds` to control audio.
- Use `extra` for project-specific transitions. Garden currently maps `shrinkToPoints`, `projectToSplats`, and `nightMode` to Spark/atmosphere changes.

When adding renderer features, prefer adding a layer under `lib/three/renderers` or `lib/three/layers`, then compose it from `SphrRuntime`.

To migrate an old SPHR/GaussianSplats3D compressed splat into the format Spark expects:

```bash
npm run convert:legacy-splat -- ../garden_splats/static/garden_high.splat public/demo/garden_demo.spark.splat --max-splats=750000 --min-alpha=16
```

Omit `--max-splats` to export every splat for a high-resolution deployment asset.

## Current Verification

This app should pass:

```bash
npm run typecheck
npm run build
```
