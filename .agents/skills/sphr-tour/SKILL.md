---
name: sphr-tour
description: Build or fix SPHR animated guided tours, including tourpoints, camera moves, text/media overlays, annotations, models, audio, and extra transitions.
---

Use this for guided-tour behavior.

## Tour Data

SPHR supports `tour_data.spaces` and legacy `tourmodels`.

Use `tour_data.mode: "guided"` for an authored tour with nonempty points. Missing/empty
tours and `mode: "explore"` automatically enter free exploration. Authored tours start
guided automatically. Never require a Start/Free Explore click or an intro screen.
Generated scan waypoints alone are
not an authored story; never turn on guided UI just because an import contains points.
A camera-only authored tour is valid even without text.

For real imported scenes, the validated composition example is
`.agents/skills/sphr-matterport/examples/create-guided-tour.mjs`; it writes a new config
and preserves measured asset geometry.

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
- `sounds` are passed to `AudioController`. Browser-blocked autoplay retries current
  narration on normal pointer/keyboard interaction; it never blocks visual scene entry.
- `extra` maps to project-specific transitions such as `shrinkToPoints`, `projectToSplats`, and `nightMode`.

## Implementation Rules

- `ViewerSession` owns tour position across `orderedSpaces`. Keep navigation global;
  a native scene or standalone MODEL stop is a renderer
  stage. A failed incoming stage must leave the previous viewer usable.
- MODEL stops use their selected scene-graph objects, the authored camera position,
  and the object bounds as the orbit target. Do not navigate to a retained nodeUUID
  on a MODEL stop. Video annotations are video textures and follow the mute state.
- For an earlier Django collection, use [the recovery workflow](../../../docs/legacy-recovery.md).
  Preserve source identities and authored media in generated data, never runtime
  branches for individual spaces. Matterport links are source inventory only: migrate
  their assets to native scenes before publication. Never add an embed renderer.
- For static legacy releases, use [compiled tour migration](../../../docs/compiled-tour-migration.md).
  Extract literal story data without executing archived bundles, select the latest
  complete release, bind original scan identities exactly, and preserve embedded
  model selections, media and visibility schedules. Story bundles alone do not
  contain the hosted panoramas. Mark authored catalog entries with `hasGuidedTour`.

- Prefer data changes over hard-coded point IDs.
- HARD GATE: Next itself is always at the bottom center of the viewport, including
  transitions and the final Continue exploring action. Center the Next button,
  not the combined Previous/Next group. Verify actual rendered bounds at desktop,
  breakpoint, and 320px mobile widths before deploying.
- If a new `extra` is reusable, implement it in a named runtime method or layer.
- Mobile guided tours require a full-width 72px Next text button at the bottom and a
  small Previous button above it. Next is white with black text; accents are `#0098db` blue. Reserve space for both below the tour copy. Keep
  guide/free-explore and optional mute controls in the top header. Do not
  show share/copy-link or fullscreen buttons.
- Keep the Next label visible on desktop too. Authored copy stays visible in guided mode; there is no text visibility toggle.
- Dollhouse is a bottom control visible only in free exploration, never guided mode.
- Tour copy, header icons, and bottom navigation must not overlap, including at 320px.
- Do not hide broken timing behind instant jumps. Animated tours should visibly transition unless the user requests otherwise.

## Verification

```bash
node .agents/scripts/project/validate-bootstrap.mjs <config>
npm run typecheck
npm run build
node .agents/scripts/project/verify-app.mjs --url "http://localhost:3000/?config=/configs/<config>.json" --screenshots
```

Final response should report tourpoint count, key transitions/extras, media/model/audio hooks touched, and verification outcome.
