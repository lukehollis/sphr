# Direct scene entry and first-person clicking

Verified 2026-09-16. This supersedes the entrance-screen and text-button behavior
recorded in `design-verification.md` and earlier capture reports.

## Current behavior

- Every route automatically enters its scene after initialization. Authored tours
  start guided; imports/missing tours start in free exploration. No intro, Start,
  or Free Explore action is rendered. Only a temporary progress status is shown;
  initialization errors retain Retry and a collection link.
- Viewer, sharing, and Previous/Next controls are icons with accessible names,
  tooltips, pressed states where relevant, and 44px targets.
- In FPV, a single click on a marker or floor chooses a reachable scan. Marker hit
  areas include the hole inside the visible ring. Floor hits choose a nearby scan
  at the measured level; directional clicks compare horizontal bearings. Candidate
  scans still come from the existing neighbor/occlusion filter.
- Drags track their full movement, and multi-pointer/canceled interactions are
  excluded from click navigation. Dollhouse single clicks stay in overview;
  double-click returns retain the existing camera flight and late panorama blend.
- Autoplay rejection never blocks visual entry. Only current narration retries on
  ordinary pointer/keyboard interaction. Leaving guided mode clears narration.

## Executed checks

- `npm run typecheck` and `npm run build`: passed.
- `npm run test:navigation`: 10 tests passed covering floor selection, active scan,
  level separation, direction ordering, empty targets, blocked audio retry, obsolete
  narration, and disposal.
- `node scripts/test-scene-routes.mjs http://localhost:3002`: all three real routes,
  redirects, thumbnails/configs, collection, legacy links, and 404 passed.
- `git diff --check`: passed.

## Browser observations

Used the host browser and production assets, not a mock or standalone browser script.

- Harvard canonical route opened directly at scan-000 without a start interaction.
  At 1280×900 a single floor click between markers moved to scan-006, with a changed
  camera position and settled navigation. A marker click then moved to scan-014.
- Dragging at scan-014 changed the view while preserving scan ID and camera position.
- In dollhouse, a single surface click stayed ORBIT; double-click began an FPV flight
  with the mesh still visible, then settled into scan-012.
- At 390×844, a single marker click moved scan-012 → scan-009. All five tourless HUD
  buttons contained icons and no visible button text. No entrance DOM remained.
- Garden loaded into guided mode automatically with real Spark rendering and tour
  text. Next advanced to point 1; turning the guide off hid text and tour navigation.
  At 320×740 the title, copy, tour navigation, and both HUD groups did not overlap.
  All eight guided controls were icon-only with accessible names.
- No console errors observed in Harvard or Garden. The existing camera movement,
  measured scene geometry, and photographs were retained.

The navigation selector and browser-autoplay policy have automated coverage.
The browser observations above are explicit mouse interactions at desktop and mobile
viewport sizes; they do not claim a physical-device multitouch or audio-listening test.
