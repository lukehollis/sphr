# SPHR workspace

This directory is the Git repository and Next.js application. From the parent
`sphr` workspace, run application commands with `sphr-next` as the working directory.
Keep existing user changes. Build complete implementations and inspect real rendering.

## Local workflows

- Matterport ZIP/E57 ingestion or repair: read [.agents/skills/sphr-matterport/SKILL.md](.agents/skills/sphr-matterport/SKILL.md).
- Panorama interaction changes: read [.agents/skills/sphr-360/SKILL.md](.agents/skills/sphr-360/SKILL.md).
- Authored tours: read [.agents/skills/sphr-tour/SKILL.md](.agents/skills/sphr-tour/SKILL.md).
- Verification: read [.agents/skills/sphr-verify/SKILL.md](.agents/skills/sphr-verify/SKILL.md).
- Roles and their handoffs live in `.agents/agents/`; these are responsibilities,
  not a requirement to spawn agents or to create separate user tasks.

The importer is tracked in `scripts/matterport/`. Generated packages live in
`public/datasets/matterport/` and are ignored by Git. Raw exports stay outside `public`.
All captures use the same calibrated pipeline and generic viewer; no per-capture
runtime transforms, image permutations, camera-height constants, or custom UI branches.
Keep capture-specific IDs, configurations, source filenames, and migration reports
out of committed code and examples. Store them in ignored local records or the
external capture store. Use generic fixtures in regression tests and parameterized
paths in examples. GitHub changes must apply across captures.

The homepage is the scene collection. Canonical links are `/s/<sceneId>/<title-slug>`;
IDs persist in package manifests across reimports and title changes. See
[collection and hosting](docs/scene-library.md). Never regenerate IDs for existing scenes.
Mused deploys the app on GCP `struct25` and assets to GCS. Read [Mused hosting](docs/mused-hosting.md)
before publishing. Use `npm run scenes:publish`; preserve remote scenes and publish
the catalog only after immutable assets upload successfully. Keep raw exports private.
On app.mused.com, website visibility is admin-controlled and new scene IDs default to
Private. Preserve `/var/lib/sphr` across deploys. This gates the web viewer only: the
user explicitly keeps the generated files and catalog in the public bucket. Do not
move assets or change bucket access when toggling website visibility. See the admin
section in `docs/mused-hosting.md` before changing authentication or publishing.

## Current viewer contract

Every space opens automatically when ready, with no intro or Start/Free Explore gate.
Imported scans enter free exploration (`tour.tour_data.mode: "explore"`); authored
tours start guided and alone expose guide/text toggles and Previous/Next. The top header
contains the scene title and viewer controls, including a switch followed by “Guide”
for toggling guided/free-explore mode. Do not use a lightbulb for this control.
On mobile, keep a full-width 72px Next text button at the bottom, with a small Previous
button above it. Dollhouse stays at the bottom and is visible only in free exploration.
Other viewer controls use accessible icon buttons. Show mute only
when audio is configured; never expose the debug markers button in the viewer. Single-click a
floor marker or nearby floor in first person to move to a reachable scan. Double-click dollhouse surfaces/markers to enter a scan;
double-click empty background to return to the current scan.

Check real asset integrity and source alignment, then inspect actual browser behavior.
When host browser tools are provided, follow their interaction policy; standalone
Playwright helpers do not override that policy. Never equate a successful import,
HTTP 200, resource prefetch, or synthetic unit test with a visually verified scene.

## Interface design

Use the supplied NASA 1975 design system's Reversed dark theme throughout. Read
[docs/design-system.md](docs/design-system.md) before interface changes. Tokens
live in `app/design-system/`. Keep the collection free of an H1/hero; use Helvetica,
square opaque panels, ruled sections, icon controls, and the `#0098db` blue accent. Next uses white with black text, never an accent fill.
Buttons have no visible outer borders; retain keyboard focus outlines and blue active indicators.
