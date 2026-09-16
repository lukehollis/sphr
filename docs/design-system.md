# Interface design system

SPHR uses the **Reversed** dark theme from the supplied
[NASA 1975 Graphics Standards Manual Design System](../../NASA%201975%20Graphics%20Standards%20Manual%20Design%20System/README.md).
The collection, loading status, viewer controls, guided tour overlays, sharing, and
error pages share this system. Photographic and 3D scene content retain their colors.

## Source and implementation

- `app/design-system/{colors,typography,spacing}.css` derive from the reference's
  corresponding `tokens/` files. Typography and spacing retain the source tokens;
  colors replace NASA Red with the user-selected SPHR accent `#0098db` and blue hover
  shades. Import them once through `app/globals.css`.
- `app/layout.tsx` sets `data-theme="dark"` explicitly, regardless of OS preference.
- Use the supplied Helvetica → Helvetica Neue → Arimo → Arial fallback stack.
  System fonts keep viewing independent of a Google Fonts request; the optional
  reference `fonts.css` import is intentionally omitted.
- Adapt native React components to these tokens. Do not load the reference's
  browser-global React bundle or duplicate React in the application.

## Composition and controls

Use near-black page stock, warm off-white text, muted gray captions, and `#0098db` blue
as the single accent. Avoid red UI accents. Keep square corners, flat opaque panels, 8px spacing units,
3px opening/closing rules, 1px section rules, flush-left Helvetica text, and weights
400/700. Use sentence case for interface labels; preserve proper scene titles.
Avoid gradients, glass, UI shadows, decorative tracking, and serif text.
Use Lucide icons for viewer actions, with accessible labels and tooltips; this user
preference overrides the reference system’s text-only control guidance. Do not add NASA branding.

The collection has no H1 or hero. Its compact running header leads into a narrow
annotation/filter column and photographic cards. Preserve searching by title/ID,
sorting, canonical URLs, copy links, keyboard focus, and accessible control names.

Viewer controls use compact 44px icon buttons. Show mute only when the normalized
scene/tour audio configuration contains a nonempty audio URL. Do not expose a markers
or debug button in the viewer. Put viewer settings (guide/free-explore toggle, optional
mute, text, share, and fullscreen) in the top header. The guide control is a switch
to the left of the visible label “Guide”, blue when on, with `role="switch"` and
`aria-checked`; do not replace it with a lightbulb icon. On mobile, the title has its own
row above the icons. Put the dollhouse control at the bottom only in free exploration;
never show it while guided mode is active.

On mobile guided tours, Next is an essential **full-width 72px text button** fixed at
the bottom, with a smaller 44px Previous text button above it. Next has a white
background and black text, with neutral hover/disabled states; never use the accent
color as its fill. Keep both clear of the
tour copy and device safe areas. The final Continue exploring action uses the same
large bottom button. This hierarchy overrides the compact icon-only treatment for
tour navigation. Desktop tour navigation can remain compact.
Scenes open directly after loading, with no intro or Start/Free Explore action.
Tourless captures open free exploration; authored tours start guided. A small loading
status disappears automatically when ready and offers Retry only on a real error.
Clipboard fallback panels must remain visible in both the collection and the viewer.

Color transitions are 120ms and honor reduced motion. The existing camera lerp,
dollhouse transitions, panorama blending, and authored tour movement are scene
behavior and remain intact.

## Verification

Run `npm run typecheck`, `npm run build`, and the canonical scene route checks.
Inspect real desktop and mobile collection, search/empty states, automatic entry/share
controls, panorama, dollhouse and double-click return, and an authored 3DGS tour.
Check narrow (320px) viewports and keyboard focus. Do not infer scene correctness
from CSS checks or a successful build.
