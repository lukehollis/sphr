---
name: sphr-project
description: Inspect, set up, and manage the SPHR Next project envelope, scene configs, local assets, and dev URLs before deeper SPHR scene work.
argument-hint: [scene/config name or task]
allowed-tools: Read Write Glob Bash(ls *) Bash(find *) Bash(rg *) Bash(node .claude/scripts/project/sphr-state.mjs *) Bash(node .claude/scripts/project/asset-inventory.mjs *) Bash(node .claude/scripts/project/validate-bootstrap.mjs *) Bash(node .claude/scripts/project/show-url.mjs *) Bash(node .claude/scripts/tour/create-bootstrap.mjs *) Bash(npm install *) Bash(npm run dev *)
---

Use this for SPHR project state, setup, and scene/config scaffolding.

## Instructions

1. Read `.claude/rules/project.md` before changing runtime behavior.
2. Inspect state:

```bash
node .claude/scripts/project/sphr-state.mjs
node .claude/scripts/project/asset-inventory.mjs
node .claude/scripts/project/validate-bootstrap.mjs
```

3. If the user needs a new scene bootstrap, create a data-driven config:

```bash
node .claude/scripts/tour/create-bootstrap.mjs --type splat --title "Scene Title" --out public/configs/scene-title.json
node .claude/scripts/tour/create-bootstrap.mjs --type spaces --title "Pano Tour" --pano-url /path/to/pano.jpg --out public/configs/pano-tour.json
node .claude/scripts/tour/create-bootstrap.mjs --type iiif --title "IIIF Scene" --iiif-url https://... --out public/configs/iiif-scene.json
```

4. If a dev URL is needed:

```bash
node .claude/scripts/project/show-url.mjs --port 3000
node .claude/scripts/project/show-url.mjs --config public/configs/scene-title.json
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
