---
name: sphr-vfx
description: Add or fix SPHR visual effects, transitions, scene graph visibility, annotation effects, Spark recoloring, atmosphere changes, and interaction polish.
argument-hint: [effect/transition/interaction request]
allowed-tools: Read Write Glob Bash(ls *) Bash(rg *) Bash(node .agents/scripts/project/validate-bootstrap.mjs *) Bash(node .agents/scripts/project/verify-app.mjs *) Bash(npm run typecheck *) Bash(npm run build *)
agent: sphr-vfx
---

Use this for SPHR VFX and interaction polish.

## Runtime Surfaces

- `SparkSplatLayer` for Spark mesh opacity, recolor, reveal, and study modes.
- `SphrRuntime` for camera movement, atmosphere, event handling, and tour state.
- `AnnotationLayer` for annotation planes.
- `SceneGraphLayer` for GLB/model/lights visibility.
- `PanoramaLayer` and `IiifImageLayer` for non-splat visual layers.
- `app/globals.css` for HUD/tour/loading responsiveness.

## Effect packs

Reusable effects and object shapes live in packs (`lib/experience/registry.ts`,
core in `lib/experience/core/`). `EffectsLayer` runs effect instances per stop;
`ObjectLayer` places objects. Splat effects add GPU modifiers through
`context.splats.addModifier` and call `invalidate()` when uniforms change.
Panorama effects draw over `context.surfaces()` (the capture mesh) with
`depthFunc: LessEqualDepth`; the mesh writes depth while a tour places objects.
Add new effects to a pack with metadata (label, one-sentence description,
targets, params with ranges) so the builder and the tour agent can offer them.

## Looks (frame styles and transitions)

A look is a full-frame restyle in `lib/three/looks` (`LookPass`). With a look
active, the frame renders into a HalfFloat target with Spark's `encodeLinear`
on, and a fragment shader calls the look's `vec3 look(vec2 uv)` body, which can
use `SAMPLE`, `LUM`, `SATURATE`, `SOBEL`, `EDGES`, `BLUR`, `HASH`, `NOISE`,
`COVER`, `DRAWN`, `RAY`, `P(param)` and `HAS_VARIANT`. Transitions (`cut`,
`fade`, `dissolve`, `wipe`, `iris`, `sweep`, `glitch`) blend two looks in the
same shader. Add a look as a `LookEntry` in a pack's `looks`
(`lib/experience/core/looks.ts` for open source ones) with a label, a one-sentence
description, params with ranges, an optional `backdrop` (paper looks need a
light background behind splats), `variant: "sketch" | "watercolor"` when it
reads a drawn version, `splats` to shrink or flatten splats while it is on
(dots, cutouts), and `requires: "splats"` when it only works in splat spaces.
The builder's Looks tab and the tour agent list every registered look
automatically.

Drawn versions follow the 3D line drawings method (informative-drawings, as in
splatline): `scripts/lines/linework.py` redraws every panorama face offline, and
for splats a companion trained on drawn photos is listed with a `role`.
`PanoramaLayer.prepareVariant` and `SparkSplatLayer.prepareVariant` load them
lazily; check `variantReady` before relying on `HAS_VARIANT`.

## Implementation Rules

- Effects must serve tour comprehension or scene interaction. Avoid decorative-only clutter.
- Prefer layer-level APIs such as `setStudyMode`, `showOnly`, `show`, `setVisible`, or a new clear method.
- Keep frame-loop work bounded. Do not add per-frame allocations in hot paths.
- Use stable dimensions and responsive constraints for controls.
- Verify desktop and mobile screenshots; mobile controls must not overlap tour nav/copy.

## Common Effects

- Splat reveal: opacity/scale easing after Spark initialization.
- Study mode: recolor/opacity changes tied to tourpoint `extra`.
- Night/atmosphere: fog and tone exposure in `SphrRuntime.applyAtmosphere`.
- Annotation reveal: show only active annotation IDs for the current point.
- Model focus: scene graph `showOnly(point.models)`.

## Verification

```bash
npm run typecheck
npm run build
node .agents/scripts/project/verify-app.mjs --url http://localhost:3000 --screenshots
```

Final response should report the exact runtime layer changed, the user-facing effect, and verification outcome.
