# Matterport migration repair

## Acceptance

- Import the complete new Matterport E57/ZIP without scene-specific code.
- Derive image orientation from image camera poses and preserve metric coordinates.
- Build and validate a reduced mesh at or below 50,000 triangles.
- Infer floor positions and traversable scan connections from measured geometry.
- Render original photographs without atmospheric tint, loading flashes, or cube seams.
- Inspect real navigation, guided tours, orbit, mobile layout, errors, and the existing 3DGS demo.
- Keep the converter, documentation, and regression checks in the distributable Next repository.

## Observed before changes

The existing observatory import has oversized markers, markers through walls, tinted images,
poor mesh reconstruction, and orbit framing inside the model. Source review also found
unawaited texture loads, unbounded GPU texture retention, uncancelled panorama fades,
navigation that changes heading and can select hidden markers, hard-coded floor height,
and an environment-reflection material used instead of camera-origin image projection.

## Completed — 2026-09-15

Imported the completed `mp_e57_Loomis-Michael-Telescope-Observatory_bhQQHbc3xFc.zip`.
The E57 is 3,631,255,552 bytes, with SHA-256
`64dd2a96aa4768058a970ff98338bdd669f389e4a1375ed2426583d1cc7b364e`.
No capture-specific transformation, face permutation, floor height, or tour code was used.

### Pipeline results

| Check | Result |
| --- | --- |
| Calibrated scans / panorama images | 53 / 318 |
| Default delivered face resolution | 2048 × 2048; original 4096 × 4096 retained in source |
| Metric coordinate preservation | 0 m maximum coordinate error |
| Worst scan's median point/photo RGB error | 0.0131 on a 0–1 scale |
| Worst median cube-edge RGB difference | 0.0373 on a 0–1 scale |
| Measured camera heights | 1.153–1.654 m |
| Mesh reduction | 2,778,735 → 49,999 triangles |
| Point-to-reduced-mesh distance | Median 1.09 cm; 95th percentile 7.18 cm |
| Mesh / photo atlas | 7.88 MB GLB; embedded 4096 × 4096 atlas |
| Direct camera texture coverage | 80.25% of triangles; source color fallback elsewhere |
| Navigation connectivity | All 53 scans in one component; no isolated scan |

The old cube convention produced a 180° yaw error relative to the measured geometry.
The replacement derives face order/quarter turns from image poses and preserves scan
quaternions. Measured-depth TSDF fusion replaces the old surface reconstruction.
Photo baking, measured floor planes, sightline-tested connections, image hashes,
mesh hash, source-bound validation, and staged publication run automatically.

A complete clean import including reconstruction and atlas baking passed end to end.
Every generated panorama JPG and mesh GLB matched the reviewed package byte for byte.
A subsequent metadata-only reimport verified safe reuse against the source hash,
and regenerated automatic eye-level opening views and matching covers. Each import
checks every scan and all 12 cube edges before publication.

### Viewer review

The viewer now waits for textures, bounds the texture cache, preserves heading during
free navigation, filters occluded markers, projects the panorama from the fixed source
camera onto the mesh, and handles failed navigation without losing the current scene.
The overview uses the photo-textured mesh and frames its bounds. The library provides
an entry point for local imports and the existing Gaussian-splat demo.

Reviewed through the actual browser UI:

- Full desktop production scene and clean library, start and free exploration.
- Actual floor-marker movement, guided Next/Previous, and location selection.
- Projected-mesh movement, including correction of an observed triple-image ghost.
- Textured cutaway overview and return to the active scan.
- Stair landing at Location 15, dark roof at Location 32, and panorama poles.
- All 53 locations at a 390 × 844 mobile viewport; final location settled without error.
- Mobile title, scan picker, previous arrow, and tour controls without overlap.
- Missing-image injection: previous photo retained, error displayed, controls recover,
  and a subsequent valid navigation succeeds. Temporary failure fixture removed.
- Existing 3DGS garden demo: 3,810,048 splats and working guided navigation.

`npm run typecheck`, `npm run build`, `npm run test:matterport`, Python undefined-name
checks, and `git diff --check` passed. Five numerical regression tests cover shuffled
camera order, arbitrary scan rotations, invalid cube sets, metric handedness, and
measured floor handling including missing nadir observations.

### Source limits

Some rooftop photos are dark in the E57 itself, and the depth capture has unobserved
surfaces. The importer preserves those photographs and does not fabricate missing
geometry. The 50k mesh and texture atlas are reductions; the stationary panorama is
the photographic view. This validates the complete new capture, not every possible
Matterport export variant. Unsupported image-camera layouts fail explicitly.

### Dollhouse double-click follow-up

Double-clicking a surface or marker enters the nearest scan at eye level in guided
and free exploration. Empty background returns to the current scan. Single-clicks
stay in dollhouse, and an in-flight overview camera tween is cancelled when jumping.
Verified real guided room entry, free-mode marker entry, unchanged single-click state,
and background return in the production browser. Typecheck and production build passed.

### Tour availability follow-up

The scene header now contains only its title. Generated imports declare exploration
waypoints rather than an authored tour. Missing, empty, and exploration-only tours
offer only Free Explore, without guide, text, or Previous/Next controls. Authored tours
retain both modes. Eight normalization cases passed, including a single camera-only
authored tour and legacy `tourmodels`. Production browser review covered the Observatory,
a real scene with `tour: null`, and starting/advancing the authored 3DGS garden tour.
The temporary no-tour fixture was removed. Typecheck and production build passed.
