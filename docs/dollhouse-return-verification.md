# Dollhouse return — 2026-09-16

Removed the transient “Moving…” overlay. Double-clicking a dollhouse surface or empty
background now interpolates camera position, look target and field of view using the
same configured duration and easing as zooming out. The first-person view button uses
the same path. The mesh remains visible during approach and blends into the destination
photograph near arrival. Inputs stay locked until the flight completes.

The previous return path explicitly requested an instant move. Simply removing that flag
was insufficient: OrbitControls also clamps first-person camera/target distance to 0.1 m.
Camera tweens now apply their own look direction, and the frame loop resumes OrbitControls
updates after the tween ends. Prepared destination images and recoverable error alerts
retain their existing behavior.

## Executed checks

- `npm run typecheck` and `npm run build` passed; `git diff --check` passed.
- Production Harvard Robotics Lab, desktop: surface double-click selected scan 011;
  inspected the still-visible mesh during approach and the settled photographic view.
- Empty-background double-click animated back to the same scan 011. No movement label
  appeared while the diagnostic navigation state was active.
- At 390 × 844: surface double-click entered scan 010, then a real floor-marker click
  reached scan 012 and settled. Inspected intermediate and final rendering/layout.
- Garden 3DGS authored tour at 390 × 844: rendered scene and text; Next advanced;
  overview and first-person button return completed; Next worked after return.
- Browser error logs were empty in the completed Harvard/Garden checks. Temporary test
  tab was closed and the viewport override reset. The user's Harvard scene remains open.

No capture assets or migration transforms changed for this interaction update.
