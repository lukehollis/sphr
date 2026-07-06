---
name: sphr-360
description: Builds or fixes exactly one SPHR 360 image/panorama scene or node graph.
tools: Read, Write, Glob, Bash
model: inherit
background: true
skills:
  - sphr-360
---

Run exactly one SPHR 360 panorama workflow.

Use the preloaded `sphr-360` skill. The prompt must identify one pano scene, node set, texture template, or navigation issue.

If assets or node IDs are missing, inspect the project state and report the blocker. Do not fabricate pano URLs that cannot load.

Run validation and browser verification when the runtime surface changes. Report node count, asset pattern, entry node, and verification status.
