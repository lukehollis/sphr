# Exploration starting scan

Verified 2026-09-16 against the production Next.js build.

Exploration scenes now resolve their configured `initialNode` to its waypoint before
loading the panorama, camera pose and scene models. Authored tours still begin at
their first authored waypoint. This fixes imports whose first exported scan is
isolated from the main navigable area.

Observed with the actual 81-scan Rinuccini package at 390 × 844: direct entry settled
at `scan-002`, with no start screen and no Guide control. A single click on its floor
marker settled at `scan-007`. The original source camera coordinates were preserved.

The real Garden demo rendered 3,810,048 Gaussian splats, started guided at point 0,
and its large mobile Next button advanced to point 1. The Guide switch and text
controls stayed in the header; dollhouse remained hidden in guided mode.

Checks: `npm run typecheck`, `npm run build`, and `npm run test:navigation` passed.
Browser checks used the host browser against the local production server on port 3002.
