# Navigation when an E57 does not observe the floor

Verified September 16, 2026 against the complete 145-scan Great Pyramid export.

Scan `044` has a calibrated camera and six photographs, but the source points and
full measured surface do not support a floor beneath that camera. Retain its exact
camera position, set `floorPosition: null` and `floorUnobserved: true`, and report
the limitation. The imported panorama remains part of the scene.

The viewer renders a directly selectable sphere at this camera position. Normal
floor targets retain their rings. Floor-click inference excludes unobserved floors;
camera-point selection uses the actual sphere and measured camera sightlines.
This matters for scan `045`: its only visible route back passes through `044`.
Hiding `044` entirely in first person stranded that viewpoint.

## Observed verification

- Actual Great Pyramid bootstrap opened automatically in free exploration at `000`.
- Clicking the stair marker moved `000 → 001` and settled at the original camera.
- Dollhouse showed the complete measured tunnel/chamber layout. Double-clicking the
  distant chamber returned into the photographic panorama at `101`.
- A temporary local QA sequence selected original scans `043`, `044` and `045` for
  inspection. It preserved every original camera, face URL and navigation edge; it
  was never published as a guided tour.
- In free exploration at `043`, rotating toward the source camera exposed the sphere;
  a real click moved `043 → 044` and settled in the original panorama.
- At `045`, the rebuilt viewer exposed `044` as a camera-point target. A real click
  on that sphere returned `045 → 044`.
- The source-bound package receipt passed for all 145 panoramas and the exact
  50,000-triangle GLB. Point-to-mesh distances were 0.01308 m median and 0.10851 m p95.
  Its navigation graph has two measured connected components, of 125 and 20 scans.
  The larger capture therefore still needs dollhouse entry to reach the separate area.

`npm run build` and `npm run test:navigation` passed. The build includes the real
external capture directory, not substitute assets. The Python pipeline regressions
also passed (33 tests). Existing receipts may call these nodes `overviewOnlyNodes`
and record `dollhouse-camera-point`; the updated viewer additionally permits direct
camera-point selection in first person. New pipeline receipts call them `cameraPointNodes`.
