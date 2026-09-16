---
name: sphr-matterport
description: Import and verify complete Matterport E57 captures as calibrated SPHR panoramas, a photo-textured 50k mesh, and usable navigation; diagnose migration and registration failures.
---

# Matterport E57 migration

Produce a complete package and a visually verified SPHR scene from a real export.
Run commands from the Next repository (`sphr-next` when starting in its parent workspace).
The single converter implementation is `scripts/matterport/`; `.agents` contains
procedures, roles and helpers, not a second converter.

Read the relevant references as the work reaches each stage:

1. **Discover and import:** [workflow.md](references/workflow.md). Identify the new
   download, check completeness, select dependencies, convert, publish and open.
2. **Geometry or quality:** [geometry.md](references/geometry.md) and
   [troubleshooting.md](references/troubleshooting.md). Read before changing camera
   conventions, fusion, reduction, floors, visibility, projection or validation.
3. **Verify and deliver:** [verification.md](references/verification.md). Combine
   all-scan asset checks with real desktop/mobile movement and retained 3DGS support.
4. **Integrations:** [examples.md](references/examples.md). Runnable source inspection,
   package reporting and optional authored-tour composition using real imported assets.

## Invariants

- Preserve the original ZIP/E57; raw scans stay outside public web assets.
- Preserve meters with `three = [e57.x, e57.z, -e57.y]` for every spatial object.
- Associate image cameras by data3D GUID. Derive face order and quarter turns from
  poses/intrinsics; use direct node quaternions. Seam continuity alone cannot detect
  the historic 180° panorama/geometry mismatch.
- Fuse measured depth, reduce to the configured triangle ceiling (default 50,000),
  bake calibrated photographs, and infer floors/connections from measured geometry.
- Validate before publication. Failed conversion leaves the previous package usable.
- Imported scan waypoints use `tour_data.mode: "explore"`; they are not an authored
  tour. Preserve the title-only header and automatic tourless exploration and icon controls.
- Repair the shared pipeline when a capture exposes a defect. No per-capture image
  permutations, rotation/scale corrections, height constants or custom runtime branches.

## Responsibilities

The [migration role](../../agents/sphr-matterport.md) owns the full result and receipt.
The [geometry audit role](../../agents/sphr-matterport-audit.md) checks evidence and
calibration. The [panorama role](../../agents/sphr-360.md) owns viewer behavior;
[verification](../../agents/sphr-verify.md) owns observed acceptance evidence.
Use these as local responsibilities or bounded handoffs when delegation is authorized;
they do not require spawning agents or creating separate user tasks.

## Completion

Deliver a working URL, source identity, node/face counts, actual GLB triangle count,
registration metrics, graph coverage, checks run, and source limitations. Retain
machine receipts with assets and write a concise capture review in `docs/`.
Import logs, HTTP success, prefetched images or unit tests alone are not completion.
