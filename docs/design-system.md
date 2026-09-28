# Interface design system

SPHR uses the supplied
[NASA 1975 Graphics Standards Manual Design System](../../NASA%201975%20Graphics%20Standards%20Manual%20Design%20System/README.md)
in two stocks. The viewer (loading status, viewer controls, guided tour overlays and the
space editor) uses the **Reversed** dark theme with a blue accent. Pages outside the viewer
(sign-in, accounts, spaces, plans, the upload sheet, administration, the collection,
policies and error pages) use the **Standard** light stock in the colors of the public
homepage: white paper, black ink, warm grays, and NASA red for the main action on a page.
Photographic and 3D scene content retain their colors.

## Source and implementation

- `app/design-system/{colors,typography,spacing}.css` derive from the reference's
  corresponding `tokens/` files. Typography and spacing retain the source tokens;
  the viewer's colors replace NASA Red with the user-selected SPHR accent `#0098db` and
  blue hover shades. Import them once through `app/globals.css`.
- `app/design-system/site.css` sets the light values for pages outside the viewer on
  their containers (`.site`, `.site-auth`, `.site-error`): paper `#ffffff`, tint `#f1f0ee`,
  cream `#f2efe6`, ink `#111111`, grays `#555555`/`#888888`, hairline `#dddddd` and NASA
  red `#e03c31` (pressed `#c33228`). `spaces.css` styles Your spaces, the upload sheet and
  plans with the same values.
- `app/layout.tsx` sets `data-theme="dark"` explicitly, regardless of OS preference.
- Use the supplied Helvetica → Helvetica Neue → Arimo → Arial fallback stack.
  System fonts keep viewing independent of a Google Fonts request; the optional
  reference `fonts.css` import is intentionally omitted.
- The site name in page headers is the one exception: uppercase Silkscreen, the
  homepage's pixel face, with no icon beside it. The font is bundled in
  `app/design-system/fonts/` under the SIL Open Font License and loaded through
  `next/font/local` (`app/design-system/fonts.ts`), so it needs no font service either.
- Adapt native React components to these tokens. Do not load the reference's
  browser-global React bundle or duplicate React in the application.

## Composition and controls

In the viewer, use near-black page stock, warm off-white text, muted gray captions, and
`#0098db` blue as the single accent, without red UI accents. On pages outside the viewer,
use white paper, black ink and gray captions. Red is used sparingly there: the one main
action on a page (adding a space, paying) takes `.site-button-accent`, and small marks
(error alerts, the Public status square, link hover underlines, dimension lines on the
large drawings) may use it. Other buttons are ink, secondary buttons are outlined in ink,
and focus rings, selected states, progress and active rules are ink. Keep square corners, flat opaque panels, 8px spacing units,
3px opening/closing rules, 1px section rules, flush-left Helvetica text, and weights
400/700. Use sentence case for interface labels; preserve proper scene titles.
Avoid gradients, glass, UI shadows, decorative tracking, and serif text.
Use Lucide icons for viewer actions, with accessible labels and tooltips; this user
preference overrides the reference system’s text-only control guidance. Do not add NASA branding.
Viewer buttons have no visible outer borders in normal, hover, or disabled states; on
pages outside the viewer, secondary buttons carry a 1px ink outline as on the homepage.
Keep keyboard focus outlines and active indicators (blue in the viewer, ink on pages),
and preserve control dimensions.

The collection has no visible heading, counts, or instructions. Its compact footer
contains the current-year copyright linked to mused.com and Login / Sign up links
to Mused's existing account pages. Keep it in normal collection flow and at the
bottom of short/empty collections, with a section rule and muted text. Full-screen
viewers retain their existing controls without a collection footer. Keep the
search/sort controls and photographic cards. Each card contains only a linked
thumbnail and title; authored stories also carry a small “Guided tour” label. An
All / Guided tours / Spaces filter separates stories from free exploration. Avoid
location counts, IDs, or copy-link controls. Preserve searching by title/ID, sorting, canonical URLs, keyboard focus,
and accessible control names. Share/copy-link and fullscreen buttons are absent
from the viewer; canonical scene URLs remain available in the address bar.

Visibility controls belong on `/admin`, where each card adds a labeled Public/Private
select. The public collection keeps the thumbnail/title-only layout. Admin forms use
the same square light surfaces, Helvetica, ink action buttons and ink focus outlines.

Viewer controls use compact 44px icon buttons. Show mute only when the normalized
scene/tour audio configuration contains a nonempty audio URL. Do not expose a markers
or debug button in the viewer. Put viewer settings (guide/free-explore toggle, optional
mute) in the top header. Omit the settings row when none of those controls
are available. The guide control is a switch
to the left of the visible label “Guide”, blue when on, with `role="switch"` and
`aria-checked`; do not replace it with a lightbulb icon. On mobile, the title has its own
row above the icons. Put the dollhouse control at the bottom only in free exploration;
never show it while guided mode is active.

Tour copy is anchored at the bottom-left on desktop in a compact panel, with
Next fixed at the bottom center. Center the Next button itself; the smaller Previous
button must not offset it. This is a hard deployment gate at every viewport width,
during transitions, and for the final Continue exploring action. Reserve clearance
above navigation so copy cannot overlap it. On smaller screens, copy and navigation share one
full-width bottom panel. Keep long copy scrollable and navigation visible. Legacy
`textPosition` values must not move copy to the top, center, or right.

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
