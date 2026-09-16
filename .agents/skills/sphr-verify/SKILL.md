---
name: sphr-verify
description: Verify actual SPHR scene rendering, package integrity, navigation, tour availability, mobile layout and production builds after implementation.
---

# SPHR verification

Read the requested change and target config. Inspect project state if paths/assets are
unclear; do not substitute the default demo for a requested capture. Use host browser
tools when supplied, and follow their interaction policy.

```sh
node .agents/scripts/project/sphr-state.mjs
node .agents/scripts/project/validate-bootstrap.mjs public/datasets/matterport/my-space/bootstrap.json
npm run typecheck
npm run build
```

For Matterport packages run `npm run test:matterport -- <dataset>` and use
[the full checklist](../sphr-matterport/references/verification.md). Source/camera/image
validation is separate from observing a usable viewer.

Where standalone browser execution is permitted, the runnable helper is:

```sh
node .agents/scripts/project/verify-app.mjs --url 'http://localhost:3002/?config=/datasets/matterport/my-space/bootstrap.json' --screenshots
```

It waits for automatic scene entry, checks HUD/layout/render diagnostics and
exercises overview/double-click return on desktop/mobile. Screenshots and numeric checks
still need interpretation; they are not automatic proof of photographic alignment.

## Accept only observed behavior

- Scene opens without any start click or intro screen. Tourless imports enter free
  exploration; authored tours start guided with working icon controls and navigation.
- Real 3DGS/panorama/IIIF content renders; assets return successfully; errors are understood.
- Real single clicks on a marker and on floor between markers change active node/camera
  and settle. Drags stay at the current scan. Prefetch is not navigation.
- Dollhouse works and double-click returns to eye-level first person.
- Desktop/mobile title and HUD do not overlap; removed branding/dropdown stay removed.
- On mobile guided tours, Next is full-width at the bottom with small Previous above,
  settings/guide toggle are in the header, and dollhouse appears only after switching
  to free exploration. Mute exists only with audio; debug markers never appear as a button.
- Runtime changes retain relevant 3DGS, tour, annotation/audio and image behavior.
- Machine receipts match the actual assets; unsupported source layouts fail explicitly.

Record exact commands and inspected scenarios/locations, screenshots when saved, and
remaining source limits. A smoke test alone is insufficient for a changed rendering path.
