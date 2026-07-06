![SPHR logo](https://github.com/user-attachments/assets/bcc6126e-4c6d-48ec-ac76-7018d6149043)

![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=nextdotjs)
![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=111)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?logo=typescript&logoColor=white)
![Three.js](https://img.shields.io/badge/Three.js-0.185-black?logo=threedotjs)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

# SPHR

SPHR is a hackable web runtime for spatial tours, digital twins, and browser-native 3D scenes.

This branch is the Next.js + Three.js migration. It removes the old separate backend requirement and ships as a client-rendered viewer that can load a default demo, a remote JSON config, or embedded bootstrap data from a host page.



https://github.com/user-attachments/assets/169c7729-e4d7-4889-99d2-42d81e33a6d8



## 3D Gaussian Splatting  

The reworked SPHR is centered on 3D Gaussian Splatting. The runtime can load splat assets or 360 images, etc directly in the browser, place them in a Three.js scene, animate camera movement through the capture, and layer guided tour text, UI controls, skyboxes, annotations, models, and effects over the scene.

SPHR uses [`@sparkjsdev/spark`](https://github.com/sparkjsdev/spark) for splat rendering. The current splat layer supports:

- `.splat`, `.ply`, `.spz`, `.ksplat`, `.sog`, and `.rad` sources
- local or remote URLs loaded through `fetch`
- per-splat position, rotation, scale, opacity, and LOD settings
- reveal animation for initial scene entry
- guided-tour study modes such as point shrinking, projected splat emphasis, and night mode
- a separate scene graph for GLB/mesh overlays, raycast targets, and transition meshes

Example splat config:

```json
{
  "space": {
    "title": "Research Garden Capture",
    "type": "splat",
    "space_data": {
      "noPanos": true,
      "initialPosition": { "x": 4, "y": 1.5, "z": 4 },
      "initialRotation": { "azimuth": 0, "polar": 90 },
      "splats": [
        {
          "id": "garden",
          "url": "https://your-asset-host.example/captures/garden.splat",
          "fileType": "splat",
          "position": [0, 2.6, 0],
          "rotation": [-2.56518, -2.66973, 0.2615546],
          "scale": 1,
          "lod": false,
          "reveal": true
        }
      ]
    }
  }
}
```

Large splat files are intentionally not meant to live in git. Host captures in object storage, a CDN, a research artifact mirror, or a local static directory that is excluded from version control.

## What It Renders

SPHR currently supports these runtime layers:

- 3D Gaussian splats through `SparkSplatLayer`
- 360 panorama nodes through `PanoramaLayer`
- IIIF image planes through `IiifImageLayer`
- custom GLB/model/light hierarchies through `SceneGraphLayer`
- 3D annotations through `AnnotationLayer`
- navigation markers and floor click navigation
- equirectangular, cube, and color skyboxes
- first-person and orbit camera modes
- guided tours with text, audio, annotations, model visibility, and camera moves

The runtime is not a visual authoring tool. It is the viewer/runtime that renders a structured SPHR scene.

## Quickstart

Install dependencies:

```bash
npm install
```

Run the Next.js dev server:

```bash
npm run dev
```

Open `http://localhost:3000`.

Build and serve a production build:

```bash
npm run build
npm run start
```

Run TypeScript validation:

```bash
npm run typecheck
```

`npm run start` is for production builds. Use `npm run dev` while developing.

## Opening 3DGS Captures

To open your own capture:

1. Export or convert the capture to `.splat`, `.ply`, `.spz`, `.ksplat`, `.sog`, or `.rad`.
2. Put the file behind a URL the browser can fetch. For remote URLs, make sure CORS allows the app origin.
3. Create a bootstrap JSON with a `space.type` of `splat` and a `space.space_data.splats` entry.
4. Load it with `/?config=/path/to/bootstrap.json`.

Useful prompts for coding agents:

```text
Find an openly available 3D Gaussian Splatting research capture with a downloadable .splat, .ply, .spz, .ksplat, .sog, or .rad asset. Confirm the license and whether the URL is browser-fetchable, then generate a SPHR bootstrap JSON that opens it.
```

```text
Use the Garden scene from recent 3DGS research as the target scene. Locate or prepare a compatible splat asset, keep large binaries out of git, and wire SPHR to it through ?config with correct position, rotation, scale, and optional skybox settings.
```

```text
Open my local 3DGS capture in SPHR. Inspect the asset format, serve it from an ignored local static path or external asset host, create a bootstrap JSON, and tune the camera start position until the scene opens correctly.
```

## Loading Your Own Scene

The app starts in `components/SphrApp.tsx` and calls `loadBootstrapData()` from `lib/bootstrap.ts`.

Bootstrap data can come from four places, in this order:

1. `?config=/path/to/bootstrap.json`
2. `window.__SPHR_BOOTSTRAP__`
3. embedded script tags with IDs `space_data`, `tour_data`, `ordered_spaces_data`, and `ui_data`
4. the built-in garden demo

The recommended integration path is a single bootstrap JSON file:

```json
{
  "space": {
    "id": "my-space",
    "title": "My Space",
    "type": "splat",
    "mesh": "/models/dollhouse.glb",
    "space_data": {
      "initialPosition": { "x": 0, "y": 1.6, "z": 4 },
      "initialRotation": { "azimuth": 0, "polar": 0 },
      "splats": [
        {
          "id": "capture",
          "url": "/captures/scene.splat",
          "scale": 1
        }
      ],
      "sceneGraph": []
    }
  },
  "tour": {
    "id": "my-tour",
    "title": "My Tour",
    "tour_data": {
      "defaultShowText": true,
      "spaces": [
        {
          "id": "my-space",
          "title": "My Space",
          "tourpoints": [
            {
              "viewMode": "FPV",
              "targetType": "FREE",
              "text": "Start here.",
              "position": { "x": 0, "y": 1.6, "z": 4 },
              "rotation": { "azimuth": 0, "polar": 0 },
              "zoom": 0
            }
          ]
        }
      ]
    }
  },
  "ui": {
    "titlePart1": "SPHR",
    "titlePart2": "Demo",
    "enterButtonText": "Enter",
    "exploreButtonText": "Explore"
  }
}
```

The authoritative schema lives in `lib/types.ts`.

## 360 Images And Navigation Transitions

SPHR also supports classic 360-image tours. A 360 space is defined as a set of nodes. Each node has a camera position and either an equirectangular image, six cube faces, or a texture template that resolves to cube faces.

Minimal node example:

```json
{
  "space": {
    "title": "360 Tour",
    "type": "spaces",
    "space_data": {
      "initialNode": "scan-000",
      "nodes": [
        {
          "uuid": "scan-000",
          "image": "/panos/scan-000.jpg",
          "position": { "x": 0, "y": 1.6, "z": 0 },
          "floorPosition": { "x": 0, "y": 0, "z": 0 },
          "rotation": { "x": 0, "y": 0, "z": 0 }
        },
        {
          "uuid": "scan-001",
          "faces": [
            "/panos/scan-001/face0.jpg",
            "/panos/scan-001/face1.jpg",
            "/panos/scan-001/face2.jpg",
            "/panos/scan-001/face3.jpg",
            "/panos/scan-001/face4.jpg",
            "/panos/scan-001/face5.jpg"
          ],
          "position": { "x": 2.5, "y": 1.6, "z": 0 },
          "floorPosition": { "x": 2.5, "y": 0, "z": 0 },
          "rotation": { "x": 0, "y": 0, "z": 0 }
        }
      ]
    }
  }
}
```

The basic 360 transition crossfades between the outgoing panorama and the incoming panorama while the camera animates to the next node.

SPHR also includes a stronger mesh-based transition for moving between 360 images. During navigation, `SphrRuntime` captures the outgoing panorama into a `WebGLCubeRenderTarget` with a `CubeCamera`. That cube texture is temporarily applied to configured scene graph meshes, usually a low-poly dollhouse or scan mesh, while the main camera flies to the next node. The transition mesh fades out as the new panorama becomes active. This makes the movement feel spatial instead of just cutting between two photos.

Transition config example:

```json
{
  "space_data": {
    "navigationTransition": {
      "enabled": true,
      "meshIds": ["dollhouse"],
      "opacity": 0.2,
      "meshFadeMs": 400,
      "navigationMs": 1100,
      "cubeRenderTargetSize": 2048
    },
    "sceneGraph": [
      {
        "id": "dollhouse",
        "type": "model",
        "file": "/models/dollhouse.glb",
        "visible": true,
        "persistent": true,
        "raycast": true,
        "fpvOpacity": 0,
        "orbitOpacity": 1,
        "transitionMesh": true,
        "transitionOpacity": 0.2,
        "transitionFadeMs": 400,
        "transitionTexture": "cube-render-target"
      }
    ]
  }
}
```

For this transition to run, the space needs:

- panorama nodes with images or cube faces
- a scene graph mesh marked as a transition mesh
- `navigationTransition.enabled` not set to `false`
- first-person navigation between two different nodes

Set `noPanos: true` for splat-only spaces where panorama rendering should be disabled.

## Tours

Tours are arrays of spaces and tourpoints. A tourpoint can move the camera, switch view mode, show text, reveal models, show annotations, play sounds, or trigger runtime modes through the `extra` field.

Common tourpoint fields:

- `viewMode`: `FPV` or `ORBIT`
- `targetType`: `NODE`, `FREE`, or `MODEL`
- `nodeUUID`: node to navigate to in a 360 tour
- `position`: free camera position for splat or free-flight points
- `rotation`: camera azimuth and polar angles
- `zoom`: camera FOV adjustment
- `text` and `secondaryText`: guided tour copy
- `models`: scene graph IDs to show at this step
- `annotations` or `overlays`: annotation IDs to show at this step
- `sounds`: audio IDs to play at this step
- `extra`: runtime mode such as `nightMode`, `shrinkToPoints`, or `projectToSplats`

## Scene Graph

The scene graph lets a tour add persistent or step-specific 3D content around the main capture.

Supported node uses include:

- GLB or other model files
- groups
- ambient, point, directional, and custom lights
- raycast meshes for cursor and floor navigation
- FPV, orbit, and debug-specific opacity
- transition meshes for the 360 navigation effect
- nested children with inherited transforms

Transforms use arrays for scene graph nodes:

```json
{
  "id": "artifact",
  "type": "model",
  "file": "/models/artifact.glb",
  "position": [0, 1.2, -2],
  "rotation": [0, 0.4, 0],
  "scale": 1,
  "visible": false,
  "raycast": true
}
```

## License

MIT, but if this is useful to you, please cite this repo because it helps the work continue.

```bibtex
@misc{hollis2024sphr,
  author = {Luke Hollis},
  title = {SPHR - Spatial Human Reality in a web browser},
  year = {2024},
  publisher = {GitHub},
  journal = {GitHub repository},
  howpublished = {\url{https://github.com/lukehollis/sphr}}
}
```
