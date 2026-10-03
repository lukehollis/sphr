---
name: capture-usdz-text-mesh
description: USDZ files whose build-model.mjs conversion fails because Blender lacks usd_import (Blender 3.4); the USDZ holds a text .usda with Mesh prims, Xform hierarchy and UsdPreviewSurface materials.
learned: 2026-10-03 from processing job 0be686e6442d7be7, reviewed (runner after review)
---

# USDZ without Blender USD import

Recognize: `build-model.mjs` on a `.usdz` reports `bpy.ops.wm.usd_import` could not be found. A USDZ is a ZIP;
`inspect-inputs.mjs --extract` unpacks it to a `.usda` (text) plus textures. (A binary `.usdc` needs another route.)

Steps:
1. `/opt/venv/bin/python .agents/skills/capture-usdz-text-mesh/scripts/usda2glb.py <file>.usda work/model.glb`
   It reads Mesh points/faces, composes the Xform translate/orient/scale chain using default (non-animated)
   values, triangulates, and applies each material's diffuseColor/metallic/roughness as vertex colors.
2. `node scripts/packages/build-model.mjs --input work/model.glb --title "<title>" --lit`
3. Check `preview.jpg` (upright, recognizable) and run validate-package as in sphr-intake.

Limits: textures (normal maps, diffuse maps) and animation are ignored; fully metallic materials look dark.
Time-sampled transforms fall back to defaults, so a few animated parts (cables) may sit in odd places.
