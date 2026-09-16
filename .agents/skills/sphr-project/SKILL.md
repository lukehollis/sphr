---
name: sphr-project
description: Inspect, set up, and manage the SPHR Next project envelope, scene configs, local assets, and dev URLs before deeper SPHR scene work.
argument-hint: [scene/config name or task]
allowed-tools: Read Write Glob Bash(ls *) Bash(find *) Bash(rg *) Bash(node .agents/scripts/project/sphr-state.mjs *) Bash(node .agents/scripts/project/asset-inventory.mjs *) Bash(node .agents/scripts/project/validate-bootstrap.mjs *) Bash(node .agents/scripts/project/show-url.mjs *) Bash(node .agents/scripts/tour/create-bootstrap.mjs *) Bash(npm install *) Bash(npm run dev *)
---

Use this for SPHR project state, setup, and scene/config scaffolding.

## Instructions

1. Read `.agents/rules/project.md` before changing runtime behavior.
2. Inspect state:

```bash
node .agents/scripts/project/sphr-state.mjs
node .agents/scripts/project/asset-inventory.mjs
node .agents/scripts/project/validate-bootstrap.mjs
```

3. If the user needs a new scene bootstrap, create a data-driven config:

```bash
node .agents/scripts/tour/create-bootstrap.mjs --type splat --title "Scene Title" --out public/configs/scene-title.json
node .agents/scripts/tour/create-bootstrap.mjs --type spaces --title "Pano Tour" --pano-url /path/to/pano.jpg --out public/configs/pano-tour.json
node .agents/scripts/tour/create-bootstrap.mjs --type iiif --title "IIIF Scene" --iiif-url https://... --out public/configs/iiif-scene.json
```

4. If a dev URL is needed:

The homepage is the scene collection. Use `/s/<sceneId>/<title-slug>` for permanent
imported-scene links and `/?demo=garden` for the demo. IDs persist in manifests; never
regenerate them during a title change or reimport. Read `docs/scene-library.md` for
catalog backfill, sharing and public-host setup. `npm run scenes:index` indexes existing
packages without reconverting their assets.

```bash
node .agents/scripts/project/show-url.mjs --port 3000
node .agents/scripts/project/show-url.mjs --config public/configs/scene-title.json
```

5. If the dev server is not running, start it from repo root:

```bash
npm run dev -- --port 3000
```

6. Report state concisely:
   - whether dependencies are installed
   - default demo asset status
   - active scene/config path
   - URL to open
   - what downstream skill should handle the next real implementation step

Do not tell the user Django is required for rendering. It is optional for admin/API data only.
