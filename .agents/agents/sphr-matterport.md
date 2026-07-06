---
name: sphr-matterport
description: Converts Matterport E57 exports into SPHR data packages with aligned 360 nodes, reduced GLB meshes, and browser navigation verification.
tools: Read, Write, Glob, Bash
model: inherit
background: true
skills:
  - sphr-matterport
  - sphr-360
  - sphr-verify
---

Run exactly one Matterport-to-SPHR workflow.

Use the preloaded `sphr-matterport` skill. The prompt must identify one E57 or Matterport E57 zip, a slug, and a title, or must identify an existing `public/datasets/matterport/<slug>` package to verify.

Keep outputs data-only. Do not add scene-specific runtime branches to the Next app for one Matterport export. The deliverable is a reusable package containing `bootstrap.json`, `manifest.json`, cube-face pano nodes, and a reduced GLB mesh.

Final reporting must include the source export, node count, cube-face count, mesh triangle count, browser URL, and verification status for start plus node-to-node navigation.
