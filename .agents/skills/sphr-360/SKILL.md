---
name: sphr-360
description: Build and verify SPHR 360 panorama scenes using equirectangular images, cube faces, node navigation, and guided tourpoints.
argument-hint: [config/node asset instructions]
allowed-tools: Read Write Glob Bash(ls *) Bash(rg *) Bash(node .claude/scripts/project/asset-inventory.mjs *) Bash(node .claude/scripts/project/validate-bootstrap.mjs *) Bash(node .claude/scripts/tour/create-bootstrap.mjs *) Bash(node .claude/scripts/project/verify-app.mjs *) Bash(npm run typecheck *) Bash(npm run build *)
agent: sphr-360
---

Use this for SPHR 360 image tours.

## Data Contract

Set `space.type` to `spaces` and define `space.space_data.nodes`.

Equirectangular node:

```json
{
  "uuid": "entry",
  "image": "/panos/entry.jpg",
  "position": { "x": 0, "y": 1.5, "z": 0 },
  "rotation": { "x": 0, "y": 0, "z": 0 }
}
```

Cube-face node:

```json
{
  "uuid": "room-a",
  "faces": [
    "/panos/room-a/px.jpg",
    "/panos/room-a/nx.jpg",
    "/panos/room-a/py.jpg",
    "/panos/room-a/ny.jpg",
    "/panos/room-a/pz.jpg",
    "/panos/room-a/nz.jpg"
  ],
  "position": { "x": 2, "y": 1.5, "z": -3 }
}
```

Template node:

```json
{
  "uuid": "room-b",
  "textureTemplate": "/panos/{uuid}/{face}-{resolution}.jpg",
  "resolution": "2k",
  "position": { "x": 4, "y": 1.5, "z": -5 }
}
```

`PanoramaLayer` supports equirectangular spheres and cube faces. `NavigationLayer` handles floor markers and click navigation.

## Tourpoints

For pano tours, tourpoints should use `targetType: "NODE"` and `nodeUUID`:

```json
{
  "id": "entry-intro",
  "nodeUUID": "entry",
  "targetType": "NODE",
  "viewMode": "FPV",
  "rotation": { "azimuth": 30, "polar": 0 },
  "zoom": 12,
  "text": "Intro text"
}
```

## Verification

Run asset inventory and bootstrap validation before browser testing:

```bash
node .claude/scripts/project/asset-inventory.mjs
node .claude/scripts/project/validate-bootstrap.mjs <config>
npm run typecheck
npm run build
node .claude/scripts/project/verify-app.mjs --url "http://localhost:3000/?config=/configs/<config>.json" --screenshots
```

Final response should report node count, asset pattern, initial node, tourpoint count, and verification outcome.
