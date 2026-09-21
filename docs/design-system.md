# Interface design system

SPHR uses the **Reversed** dark theme from the supplied
[NASA 1975 Graphics Standards Manual Design System](../../NASA%201975%20Graphics%20Standards%20Manual%20Design%20System/README.md).
The collection, loading status, viewer controls, guided tour overlays, and
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
Buttons have no visible outer borders in normal, hover, or disabled states. Keep
keyboard focus outlines and blue active indicators, and preserve control dimensions.

The collection has no visible heading, counts, instructions or operator branding.
When access control is enabled, its compact footer links to the local `/admin` login.
Without access control there is no footer. Do not hard-code a deployment's copyright,
account services or external signup links in the open-source UI. Full-screen viewers
retain their existing controls without a collection footer. Keep the
search/sort controls and photographic cards. Each card contains only a linked
thumbnail and title; authored stories also carry a small “Guided tour” label. An
All / Guided tours / Spaces filter separates stories from free exploration. Avoid
location counts, IDs, or copy-link controls. Preserve searching by title/ID, sorting, canonical URLs, keyboard focus,
and accessible control names. Share/copy-link and fullscreen buttons are absent
from the viewer; canonical scene URLs remain available in the address bar.

Visibility controls belong on `/admin`, where each card adds a labeled Public/Private
select. The public collection keeps the thumbnail/title-only layout. Admin forms use
the same square dark surfaces, Helvetica, white action buttons and blue focus outlines.

Viewer controls use compact 44px icon buttons. Show mute only when the normalized
scene/tour audio configuration contains a nonempty audio URL. Do not expose a markers
or debug button in the viewer. Put viewer settings (guide/free-explore toggle, optional
mute) in the top header. Omit the settings row when none of those controls
are available. The guide control is a switch
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
tour navigation. Desktop Next also has a visible text label. Do not expose a text visibility toggle;
authored copy stays visible in guided mode.
Scenes open directly after loading, with no intro or Start/Free Explore action.
If the first authored stop has no copy or media, show the saved tour description
there so removing the old start screen does not discard its introduction.
Tourless captures open free exploration; authored tours start guided. While assets load,
show a dark graph-paper sheet over the space's blurred thumbnail, with fine drafting
lines, a muted gray wireframe, the scene title, and real loading progress. The loader
uses neutral grays without animated accent highlights or corner marks. Canonical
scene routes provide the thumbnail with the initial page, before fetching the scene
configuration. Missing images retain the grid backdrop. Respect reduced motion and
remove the loader immediately when ready; offer Retry only on a real error.

Color transitions are 120ms and honor reduced motion. The existing camera lerp,
dollhouse transitions, panorama blending, and authored tour movement are scene
behavior and remain intact.

## Verification

Run `npm run typecheck`, `npm run build`, and the canonical scene route checks.
Inspect real desktop and mobile collection, search/empty states, automatic entry,
panorama, dollhouse and double-click return, and an authored 3DGS tour.
Check narrow (320px) viewports and keyboard focus. Do not infer scene correctness
from CSS checks or a successful build.
