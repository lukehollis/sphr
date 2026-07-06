# SPHR Next

You are working in `sphr-next`, the standalone Next.js SPHR viewer. Build real interactive scene/tour functionality. Do not ship toy-only substitutes when the request is for working 3DGS, 360, IIIF, VFX, or tour behavior.

## Runtime Contract

- Next.js is the app/runtime. Django is optional for CMS/admin/API data and is not required to render scenes.
- The viewer must support these scene families:
  - Spark-rendered 3D Gaussian splats.
  - 360 panorama tours using equirectangular images or cube faces.
- IIIF image scenes.
- Animated guided tours with camera motion, annotations, audio, model visibility, and project-specific VFX.
- Matterport E57-derived spaces as data packages with aligned 360 scan nodes and reduced GLB meshes.
- Keep scene-specific behavior data-driven where possible. Prefer extending normalized bootstrap/tour data before hard-coding scene branches.
- Use `@sparkjsdev/spark` for 3DGS rendering. Do not reintroduce the old GaussianSplats3D renderer.

## Important Files

```text
app/
components/
lib/bootstrap.ts
lib/types.ts
lib/three/SphrRuntime.ts
lib/three/renderers/
lib/three/layers/
public/demo/
scripts/convert-legacy-splat.mjs
.claude/
```

`lib/bootstrap.ts` accepts bundled defaults, `?config=/path.json`, embedded Django-style script tags, and `window.__SPHR_BOOTSTRAP__`.

## Bootstrap Shape

Use this envelope for new workflows:

```json
{
  "space": {
    "id": "space-id",
    "title": "Space Title",
    "type": "splat",
    "space_data": {
      "initialPosition": { "x": 0, "y": 1.5, "z": 4 },
      "initialRotation": { "azimuth": 0, "polar": 0 },
      "splats": [
        {
          "id": "main",
          "url": "/demo/garden_demo.spark.splat",
          "lod": false,
          "reveal": true
        }
      ]
    }
  },
  "tour": {
    "title": "Tour Title",
    "tour_data": {
      "spaces": [
        {
          "id": "space-id",
          "tourpoints": []
        }
      ]
    }
  }
}
```

For 360 tours, set `space.type` to `spaces` and provide `space_data.nodes`. Nodes can use `image`, `faces`/`cubeFaces`, or `textureTemplate`.

For Matterport E57 imports, keep conversion logic in `../data/pipelines/matterport_e57_to_sphr.py` and outputs under `public/datasets/matterport/<slug>`. Do not add one-off runtime branches for a single Matterport export.

For IIIF scenes, set `space.type` to `iiif` with `space.src`, or use `space_data.iiif`.

## Asset Rules

- Public runtime assets live under `public/` and should be referenced with absolute web paths such as `/demo/foo.splat`.
- Legacy compressed SPHR/GaussianSplats3D splats must be converted before Spark rendering:

```bash
node scripts/convert-legacy-splat.mjs <legacy.splat> public/demo/<scene>.spark.splat --max-splats=750000 --min-alpha=16
```

- Omit `--max-splats` only for high-resolution deployment assets. The default demo should load fast enough for browser verification.
- Use `node .claude/scripts/media/inspect-splat.mjs <asset>` after conversion to catch invalid sizes and absurd ranges.

## Verification

Smoke tests are not enough for scene work. After runtime, renderer, tour, or CSS changes, run:

```bash
npm run typecheck
npm run build
node .claude/scripts/project/verify-app.mjs --url http://localhost:3000 --screenshots
```

Browser verification should confirm:

- The default scene reaches an enabled Start button.
- Starting the tour mounts HUD/tour controls.
- The 3DGS/pano/IIIF content visibly renders in screenshots.
- Desktop and mobile controls do not overlap.
- No failed resource requests.

## Agent Usage

Use the focused SPHR agents/skills instead of hand-waving broad scene work:

- `sphr-project` for state, config, asset inventory, and project setup.
- `sphr-3dgs` for Spark splat import/conversion/placement.
- `sphr-360` for panorama nodes and navigation.
- `sphr-iiif` for IIIF image server scenes.
- `sphr-tour` for animated tours and story flow.
- `sphr-vfx` for transitions, annotations, scene graph, shaders/modifiers, and interaction polish.
- `sphr-verify` for final browser/type/build verification.
- `sphr-matterport` for Matterport E57 extraction, aligned cube-face nodes, 50k GLB generation/repair, and browser navigation QA.
