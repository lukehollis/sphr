---
name: sphr-iiif
description: Build and verify SPHR IIIF image server scenes and inspectable image planes.
argument-hint: [IIIF image/canvas/service URL or config]
allowed-tools: Read Write Glob Bash(ls *) Bash(rg *) Bash(node .claude/scripts/project/validate-bootstrap.mjs *) Bash(node .claude/scripts/tour/create-bootstrap.mjs *) Bash(node .claude/scripts/project/verify-app.mjs *) Bash(npm run typecheck *) Bash(npm run build *)
agent: sphr-iiif
---

Use this for SPHR IIIF image scenes.

## Data Contract

Set `space.type` to `iiif`. Use either `space.src` or `space.space_data.iiif`.

```json
{
  "space": {
    "id": "iiif-scene",
    "title": "IIIF Scene",
    "type": "iiif",
    "src": "https://example.org/iiif/image/full/1600,/0/default.jpg",
    "space_data": {
      "iiif": {
        "id": "image",
        "url": "https://example.org/iiif/image/full/1600,/0/default.jpg",
        "infoUrl": "https://example.org/iiif/image/info.json",
        "position": [0, 2, -4],
        "scale": 1
      }
    }
  }
}
```

`IiifImageLayer` loads `info.json` when available to preserve aspect ratio. If `infoUrl` is absent, provide `width` and `height` or use a direct image URL.

## URL Rules

- Prefer IIIF Image API URLs for image planes.
- Keep `infoUrl` separate when available.
- Do not hard-code unstable tile URLs unless the user specifically needs a tile workflow.
- For cross-origin IIIF servers, verify browser loading. If CORS fails, report that source limitation clearly.

## Verification

```bash
node .claude/scripts/project/validate-bootstrap.mjs <config>
npm run typecheck
npm run build
node .claude/scripts/project/verify-app.mjs --url "http://localhost:3000/?config=/configs/<config>.json" --screenshots
```

Final response should report IIIF source URL, info URL/aspect behavior, config path, and verification outcome.
