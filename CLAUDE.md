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

Open the printed localhost URL for the searchable collection and permanent scene links. Use `/?demo=garden` for the
Garden Gaussian Splat demo loaded through Spark (`@sparkjsdev/spark`).

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
- `.agents/` contains SPHR-specific agent, skill, hook, rule, and helper-script workflows for 3DGS, 360 images, IIIF, animated tours, VFX, and verification.

See `AGENTS.md` for the current entrypoint and `.agents/skills/sphr-matterport/SKILL.md`
for the comprehensive import workflow, references, roles, and runnable examples.

## Agent Workflow

The `.agents` setup mirrors the product workflow:

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
node .agents/scripts/project/sphr-state.mjs
node .agents/scripts/project/asset-inventory.mjs
node .agents/scripts/project/validate-bootstrap.mjs
node .agents/scripts/project/verify-app.mjs --url 'http://localhost:3000/?demo=garden' --screenshots
node .agents/scripts/matterport/e57-to-sphr.mjs --e57 data/processed/<slug>/source/<slug>.e57 --slug <slug> --title "<Title>"
node .agents/scripts/matterport/verify-dataset.mjs --slug <slug> --url http://localhost:3000 --screenshots
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

For Matterport imports, use `npm run import:matterport -- --e57 /path/to/export.zip`.
The tracked pipeline lives at `scripts/matterport`; see `docs/matterport.md` for setup,
calibrated camera geometry, TSDF reconstruction, photo-textured mesh output, and verification.

New Matterport nodes use direct quaternions and camera-pose-derived cube faces. The
legacy fixed face permutation produced a 180-degree yaw mismatch relative to geometry.
Do not restore that permutation or validate only cube seams: check source camera rays
and point/photo registration for every scan. Floor heights must come from measured planes.

The reduced mesh is hidden in FPV at rest, raycastable, and visible in overview. During
movement, capture the outgoing panorama once and project it onto the mesh from its fixed
camera origin. Never use a reflective environment-map material as a projection substitute.

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
