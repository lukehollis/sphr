# Mobile guided-tour controls

Verified 2026-09-16 against the production build at localhost:3002. Supersedes the
compact mobile tour navigation recorded in earlier interface checks.

- A single full-width Next button is fixed at the bottom, 72px high. The smaller
  Previous button sits above it with a 44px touch target. Both include visible text.
- Guide/free-explore, optional mute, text, sharing, and fullscreen controls sit in
  the top header. Mobile title and icons use separate rows to prevent overlap.
- Dollhouse is rendered at the bottom only when `state.guided` is false.
- Tour text is scrollable within the space between the header and navigation, with
  margins for device safe areas. Automatic scene entry is retained.

## Verification

`npm run typecheck`, `npm run build`, `git diff --check`, and syntax checks of the
updated standalone verification helpers passed. Actual browser testing used the
host browser on the real Garden 3DGS scene, not the standalone helpers.

- At 390×844, visually inspected the large Next button, small Previous above it,
  top controls, and absence of dollhouse. No mute appeared because this tour is silent.
- Next advanced point 0 → 1, and Previous returned point 1 → 0.
- At 320×740, Next measured 288×72 at x=16, y=652; Previous measured 115×44 at y=600.
  Header, text, Previous, and Next had no intersecting bounding rectangles.
- Turning the guide off removed tour navigation and showed the 44px dollhouse
  control at x=16, y=680. The mode toggle stayed in the top header. Turning the guide
  on restored the large bottom navigation and removed dollhouse again.
- Desktop Garden retained compact tour navigation and top settings. No console
  errors were observed. Harvard loaded directly with top sharing/fullscreen and
  bottom dollhouse, without mute, markers, or tour controls.
- Temporary browser viewport changes were reset and the user's lab scene refreshed.

Camera movement, tour contents, media, and audio playback were not changed.
