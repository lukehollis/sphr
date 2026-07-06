---
name: sphr-tour
description: Build or fix SPHR animated guided tours, including tourpoints, camera moves, text/media overlays, annotations, models, audio, and extra transitions.
argument-hint: [tour/config path or behavior]
allowed-tools: Read Write Glob Bash(ls *) Bash(rg *) Bash(node .claude/scripts/project/asset-inventory.mjs *) Bash(node .claude/scripts/project/validate-bootstrap.mjs *) Bash(node .claude/scripts/tour/create-bootstrap.mjs *) Bash(node .claude/scripts/project/verify-app.mjs *) Bash(npm run typecheck *) Bash(npm run build *)
agent: sphr-tour
---

Use this for guided-tour behavior.

## Tour Data

SPHR supports `tour_data.spaces` and legacy `tourmodels`.

Tourpoint fields:

```json
{
  "id": "point-1",
  "text": "Primary tour text",
  "secondaryText": "Optional detail",
  "textPosition": "left",
  "viewMode": "FPV",
  "targetType": "NODE",
  "nodeUUID": "entry",
  "position": { "x": 0, "y": 1.5, "z": 4 },
  "rotation": { "azimuth": 0, "polar": 0 },
  "zoom": 0,
  "files": [],
  "models": [],
  "annotations": [],
  "sounds": [],
  "extra": "projectToSplats"
}
```

Runtime behavior:

- `position`, `rotation`, `zoom`, and `viewMode` drive camera pose.
- `files` render media in `TourOverlay`.
- `models` control `SceneGraphLayer.showOnly`.
- `annotations` control `AnnotationLayer.show`.
- `sounds` are passed to `AudioController`.
- `extra` maps to project-specific transitions such as `shrinkToPoints`, `projectToSplats`, and `nightMode`.

## Implementation Rules

- Prefer data changes over hard-coded point IDs.
- If a new `extra` is reusable, implement it in a named runtime method or layer.
- Keep mobile layout in mind; tour copy and nav buttons must not collide with HUD controls.
- Do not hide broken timing behind instant jumps. Animated tours should visibly transition unless the user requests otherwise.

## Verification

```bash
node .claude/scripts/project/validate-bootstrap.mjs <config>
npm run typecheck
npm run build
node .claude/scripts/project/verify-app.mjs --url "http://localhost:3000/?config=/configs/<config>.json" --screenshots
```

Final response should report tourpoint count, key transitions/extras, media/model/audio hooks touched, and verification outcome.
