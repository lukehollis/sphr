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

## Authored tours, hunts, objects and effects

The tour builder (`/admin/scenes/<id>/tour`, `components/TourBuilder.tsx`) edits an
`Experience` (`lib/experience/types.ts`): `kind` "tour" or "hunt", stops, placed
objects and effect instances. It is validated by `parseExperience`, stored in
`scene_tours`, and applied to the opening segment by `applyExperience`. Stops
written there use `format: "plain"` text. A hunt stop has `find: { objectId, hint,
found }`; its object is clickable only at that step and is collected when found.
The tour agent (`lib/server/tour-agent.ts`) writes complete drafts from a prompt
and points at pixels in panorama faces; the builder resolves those into positions
with `SphrRuntime.resolveAnchor`. See `docs/tours-and-effects.md`.

### Looks, models and sound in an experience

- **Looks** restyle the whole frame. `experience.look` covers the tour and free
  exploration; `stop.look` changes it at a stop: `{ "look": "lines", "transition":
  "sweep", "duration": 2, "params": {} }`, or `"color"` for the capture itself.
  Transitions are `cut`, `fade`, `dissolve`, `wipe`, `iris`, `sweep`, `glitch`.
  Core looks are `lines`, `watercolor`, `blueprint`, `noir`; the Spacery pack adds
  ink, toon, thermal, nightvision, flashlight, oldfilm, neon, halftone, pixel,
  duotone, xray, miniature, dream, vhs, infrared, pointillism, splatdots (splats
  only), cutout, terminal, hologram and cinematic. List them with `lookEntries()`.
  Use a look to mark a moment (a drawing that sweeps into color, blueprint for how
  a building was planned, noir for a mystery), not on every stop. The old `sketch`
  effect is retired in favor of the `lines` look with a `sweep` transition.
- **Skies** go behind the space: `experience.sky` for the tour, `stop.sky` to
  change it at a stop: `{ "sky": "milky-way", "turn": 90, "brightness": 1,
  "light": 1, "duration": 2 }`, `"none"` for the capture's own sky, or
  `{ "sky": "custom", "url": "https://...360.jpg" }` (customers upload their own
  with `POST /api/account/tours/<id>/skies` or the connector's `upload_sky`). The
  space takes on the sky's light (night darkens it, a sunset warms it; `light: 0`
  keeps the capture's light). List skies with `skyEntries()`: core has five drawn
  ones (`drawn-day`, `drawn-sunset`, `drawn-twilight`, `drawn-night`,
  `drawn-overcast`), the Spacery pack 38 photographed ones (day, cloudy, storm,
  sunrise, sunset, dusk, night with the Milky Way, moon, aurora and NASA star
  maps). Splats and models show it wherever the capture is empty; 360 photos need
  sky outlines from `scripts/skies/masks.py` (listed under `sky` in the space's
  lines manifest), or the sky only changes their light. Change the sky at a few
  story moments, and turn it to put the sun or moon behind what a stop shows.
- **Drawn versions.** `lines`, `blueprint` and `watercolor` read real drawings of
  the space when `scripts/lines/linework.py` has made them (panorama faces under
  `SPHR_LINES_BASE_URL/<sceneId>/index.json`, or a companion splat with
  `role: "sketch"` or `"watercolor"`); otherwise they trace edges in the shader.
  Run `python scripts/lines/linework.py panos --scene <id>` on a GPU host, upload
  the folder, and the looks pick it up with no data change.
- **Models.** An object's `source` is a pack shape, a library model or any https
  `.glb`. Search the library (thousands of models, sized in meters at scale 1)
  with `GET /api/library/search?q=amphora` or the connectors' `search_models`;
  the result's `url` goes in `{ "kind": "model", "url": ... }`. Characters and
  animals list their clips (`animated: idle, walk`); they play `idle` (or their
  first clip) unless the object sets `"animation": "<clip>"`. For an object the
  library lacks, model it in Blender (see below) and upload it.
- **Sound.** `sound` effects (enter, loop, found, hint, click; positional when
  targeted) and one `music` effect listed on the stops it plays through.
- **Finds, hints and clicks.** Effects that answer cues (sparkles, scan, beacon,
  confetti, ripple, halo, bloom) take `trigger`: `stop` (default) runs with its
  stop and answers every find, hint and click on its object; `found`, `hint` or
  `click` holds the effect back until that cue alone, so listing it on a stop only
  arms it. `EffectsLayer` does the holding back; `cue()` reports whether a visual
  effect showed something, and the viewer adds its own sparkles (find) or beacon
  (hint) when none did. Held back at a spot or over the whole space, an effect (or
  a `sound`) plays for the find or hint of a stop that lists it; one aimed at an
  object only ever answers its own object.

### Building tours as an agent

Customers' tours (`user_tours`) take an agent token as well as a session, so an
agent can build one end to end:

| Step | Local connector or hosted `/mcp` | Route |
| --- | --- | --- |
| Pick a space | `find_tour_spaces` | `GET /api/account/tours/spaces?q=` |
| Start | `create_tour` | `POST /api/account/tours` `{sceneId, kind, title}` |
| Draft | `draft_tour`, then `wait_for_tour` | `POST /api/account/tours/<id>/agent` `{prompt, async: true}`, poll `GET /api/account/tours/<id>` (`draft.state`) |
| Edit | `get_tour`, `save_tour` | `GET`, then `PUT` with `revision` |
| Models | `search_models`, `upload_model` (local only) | `GET /api/library/search`, `POST /api/account/tours/<id>/models` (raw GLB) |
| Share | `share_tour` | `PATCH` `{public, title}` |

Drafts started by an agent are placed on the server (`lib/server/tour-placement.ts`)
exactly as the builder places them: rays from each pixel the drafting agent chose,
cast against the capture mesh (`lib/server/capture-mesh.ts`), with the shared rules
in `lib/experience/placement.ts`. Splat and model spaces have no photographs, so the
server draws views of them with depth (`lib/server/space-views.ts`) for the agent to
point into; stops then stand at those views' cameras. Still check the result in the viewer or a
screenshot, and adjust positions in `save_tour` when something hides behind a wall.

Hunts should make visitors look around and walk a little. During a clue they can walk to
other locations and the clue stays open, and a click from anywhere counts. So aim each
clue's stop at the area the clue names, keep every find but the first out of that opening
view (turned away, up high, down low, or behind a column or corner and seen from a location
one to three steps away), let the hint say exactly where, and give unfound objects no
effects that run before the hint. A celebration of the find (confetti, ground ripples, a
patch of flowers, a sparkle burst) is aimed at the object with `"trigger": "found"`, which
holds it back until the find even on its stop's list; at the default trigger it would also
fire for a hint. The server keeps a find that only a nearby location sees.

From a shell, the local connector runs the same tools:
`node connector/server.mjs call draft_tour '{"tour_id":"<id>","request":"..."}'`.

### Custom models with Blender

When a Blender MCP is connected (or Blender runs headless:
`/Applications/Blender.app/Contents/MacOS/Blender -b -P make.py` on macOS):

1. Model in real-world meters with Z up in Blender (glTF export turns it into Y up),
   origin at the base so the object stands on the floor, low poly (under about
   50k triangles), Principled BSDF base colors or small packed textures.
   Animate with actions (one per clip, named like `idle` or `walk`); they export
   as glTF animations and play in the viewer.
2. Export glTF Binary with everything embedded:
   `bpy.ops.export_scene.gltf(filepath="tripod.glb", export_format="GLB", export_apply=True)`.
   Keep it under 25 MB; uploads reject external buffers and files without meshes.
3. `upload_model` with the tour ID and the path; it returns the model's address on
   the site (`/api/tour-files/<tour>/<file>.glb`, up to 20 per tour).
4. Add an object with that url in `save_tour` (or ask `draft_tour` to place "the
   model at <url>"), then check it in the viewer.

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
