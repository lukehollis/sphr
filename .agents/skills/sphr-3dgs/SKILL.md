---
name: sphr-3dgs
description: Integrate Spark-rendered 3D Gaussian splats into SPHR Next, including legacy conversion, file inspection, config wiring, transforms, loading behavior, and verification.
argument-hint: [splat path or config] [optional transform/quality instructions]
allowed-tools: Read Write Glob Bash(ls *) Bash(rg *) Bash(node .claude/scripts/media/inspect-splat.mjs *) Bash(node .claude/scripts/media/convert-legacy-splat.mjs *) Bash(node scripts/convert-legacy-splat.mjs *) Bash(node .claude/scripts/project/validate-bootstrap.mjs *) Bash(node .claude/scripts/project/verify-app.mjs *) Bash(npm run typecheck *) Bash(npm run build *)
agent: sphr-3dgs
---

Use this when adding or fixing a 3DGS scene.

## Source Formats

Spark can load standard `.splat`, `.spz`, `.ply`, `.ksplat`, `.sog`, and `.rad` formats through `@sparkjsdev/spark`.

Older SPHR/GaussianSplats3D compressed files may look like `.splat` but are not standard Spark `.splat` rows. Inspect first:

```bash
node .claude/scripts/media/inspect-splat.mjs <asset>
```

If the file is legacy compressed, convert it:

```bash
node .claude/scripts/media/convert-legacy-splat.mjs <legacy.splat> public/demo/<scene>.spark.splat --max-splats=750000 --min-alpha=16
```

Use a capped default for interactive web demos. Omit `--max-splats` only for high-resolution deployment assets and verify the browser can initialize it.

## Runtime Wiring

Add or update a splat config under `space.space_data.splats`:

```json
{
  "id": "main",
  "url": "/demo/scene.spark.splat",
  "fileType": "splat",
  "lod": false,
  "reveal": true,
  "position": [0, 0, 0],
  "rotation": [0, 0, 0],
  "scale": 1
}
```

Runtime implementation lives in:

- `lib/three/renderers/SparkSplatLayer.ts`
- `lib/three/SphrRuntime.ts`
- `lib/bootstrap.ts`
- `lib/types.ts`

Keep Spark as the renderer. Do not reintroduce GaussianSplats3D.

## Transform Work

For porting old scenes, preserve old transform values first, then adjust by screenshot:

- `position`: world offset for the splat mesh
- `rotation`: Euler radians
- `scale`: number or `[x, y, z]`
- `initialPosition` and `initialRotation`: camera start
- tourpoint `position`, `rotation`, `zoom`: animated camera destinations

## Verification

After changes:

```bash
node .claude/scripts/project/validate-bootstrap.mjs <config-if-any>
npm run typecheck
npm run build
node .claude/scripts/project/verify-app.mjs --url http://localhost:3000 --screenshots
```

Final response should include asset path, conversion command if used, splat count/size from inspection, config path, and verification outcome.
