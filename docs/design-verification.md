# Reversed dark theme verification

Verified 2026-09-16 against the production server on port 3002.

## Automated checks

- `npm run typecheck`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.
- `node scripts/test-scene-routes.mjs http://localhost:3002`: passed all three real
  scene routes, ID/old-title redirects, previews/configs, 404, collection and legacy URLs.

## Browser observations

Used the host in-app browser with actual converted assets, at desktop 1280×900,
mobile 390×844, and narrow mobile 320×740. Temporary viewport overrides were reset.

- Collection: no H1 in the DOM, explicit dark theme, Helvetica stack, #111111 page
  background. Real previews visible, square controls, consistent ruled layout.
- Search by Harvard scene ID returned one matching card. Clear restored all three.
  Most-locations sort ordered Loomis (53), Sphinx (50), Harvard (23).
- No-results search presented working clear actions at 320px with visible keyboard
  focus and no horizontal overflow.
- Copy link displayed its success state and copied the canonical Harvard URL.
  Entrance-screen copy link was clickable above the loading screen.
- Harvard: real cube-face panorama rendered; only Free Explore available. Text HUD
  displayed without title or control overlap, including at 320px (15px horizontal
  separation between the two control groups).
- Harvard dollhouse: textured mesh rendered. Double-clicking its surface selected
  scan-012, began a camera transition with the mesh retained, and settled into FPV.
  The DOM diagnostics showed navigating true during return and false after settling.
- Garden authored tour: both entry actions available. Real 3DGS rendered. Previous /
  Next and guide/text controls remained available. Next changed tour point and copy;
  Hide text removed the copy panel. Mobile title, text, navigation, and both control
  groups had no intersecting bounding boxes. Desktop tour placement also inspected.
- No browser console errors observed for Harvard or Garden.

This verifies the interface change. Source registration, mesh reconstruction, and
photographic calibration algorithms were not changed by the theme implementation.
