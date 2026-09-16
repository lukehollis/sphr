---
name: sphr-360
description: Build or repair SPHR panorama rendering, calibrated scan navigation, dollhouse entry and texture loading for real equirectangular or cube-face scenes.
---

# SPHR panoramas

Use real `space.space_data.nodes` (legacy `navPoints` supported) with `space.type: "spaces"`.
For raw E57 conversion, first use [sphr-matterport](../sphr-matterport/SKILL.md).
For shared runtime edits read [.agents/rules/project.md](../../rules/project.md).

## Node data

Equirectangular example:

```json
{"uuid":"entry","image":"/panos/entry.jpg","position":{"x":0,"y":1.5,"z":0}}
```

Calibrated cube example; supply actual imported values and URLs:

```json
{
  "uuid": "scan-000",
  "faces": [
    "/datasets/matterport/my-space/faces/scan-000/face0.jpg",
    "/datasets/matterport/my-space/faces/scan-000/face1.jpg",
    "/datasets/matterport/my-space/faces/scan-000/face2.jpg",
    "/datasets/matterport/my-space/faces/scan-000/face3.jpg",
    "/datasets/matterport/my-space/faces/scan-000/face4.jpg",
    "/datasets/matterport/my-space/faces/scan-000/face5.jpg"
  ],
  "position": {"x":0,"y":1.5,"z":0},
  "floorPosition": {"x":0,"y":0.025,"z":0},
  "quaternion": [0,0,0,1],
  "neighbors": ["scan-001"]
}
```

The six SPHR planes are `[+Y,+Z,-X,-Z,+X,-Y]`, not WebGL `[+X,-X,+Y,-Y,+Z,-Z]`.
The exact image right/up bases matter too: see [geometry](../sphr-matterport/references/geometry.md).
Do not copy this example's identity quaternion/positions into a real import. The converter
provides measured poses. Legacy `rotation` uses the old SPHR Euler path; new E57s use quaternions.

## Runtime behavior to preserve

- Await all incoming textures; failed loads retain the previous scene and recover controls.
- Photographs have no fog, vignette or tone-mapping changes; texture memory is bounded.
- Use measured floor markers, occlusion checks and heading-preserving free navigation.
- Keep transition mesh hidden at rest but raycastable. Capture the outgoing panorama once;
  project from its fixed camera origin, not as a reflection; fade late during movement.
- Dollhouse fits mesh bounds. Double-click surface/marker enters a nearby scan at eye level;
  background returns to current scan. Both returns use the same eased camera flight as
  zooming out, retaining the mesh until a late blend into the panorama. Single clicks/drags
  stay in dollhouse. OrbitControls must not clamp the camera during a flight.
- Navigation has no "Moving" label; real load failures remain visible and recoverable.
- Top header contains the scene title and icon settings; no location dropdown or SPHR label.
  Dollhouse stays at the bottom and is hidden while guided mode is active.
- Every scene enters automatically after loading: free exploration for missing/empty/
  exploration-only tours; guided mode for authored tours. Never add an intro/play gate.
- First-person single-clicks target full marker disks or the nearest reachable scan to
  a floor hit; drags, pinches, and canceled pointers never navigate. Keep occlusion and
  neighbor restrictions. Authored tours retain guide, text and Previous/Next icon controls. Do not infer availability from fallback camera points.

`PanoramaLayer`, `NavigationLayer`, `TextureCache`, `SceneGraphLayer` and `SphrRuntime`
share these responsibilities. Keep behavior generic instead of matching a scene title/UUID.

## Verification

Run typecheck/build for runtime edits. Follow the actual browser scenarios in
[verification.md](../sphr-matterport/references/verification.md), including marker movement,
mesh registration, poles, overview return, load failure, mobile layout and authored tours.
Report actual changed behavior and tested locations, not only a screenshot of first load.
