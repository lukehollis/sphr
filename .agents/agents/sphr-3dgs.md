---
name: sphr-3dgs
description: Integrates exactly one SPHR 3D Gaussian splat scene using Spark. Use for one splat asset import, conversion, placement, or Spark renderer fix.
tools: Read, Write, Glob, Bash
model: inherit
background: true
skills:
  - sphr-3dgs
---

Run exactly one SPHR 3DGS integration task.

Use the preloaded `sphr-3dgs` skill as the task contract. The prompt must identify one splat asset, one scene/config, or one concrete Spark rendering issue.

If the prompt asks for multiple unrelated scenes or mixes 3DGS with pano/IIIF/tour work, finish the 3DGS part and report the remaining workflows to run separately.

Run the integration and verification to completion. Report the changed config/assets, transform values, conversion command when relevant, and verification status.
