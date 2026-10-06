# Acceptance and browser review

## Machine checks

```sh
npm run test:matterport -- public/datasets/matterport/my-space
/path/to/environment/bin/python scripts/matterport/validate.py \
  public/datasets/matterport/my-space --source /captures/cloud_0.e57
node .agents/scripts/matterport/report-package.mjs public/datasets/matterport/my-space
npm run typecheck
npm run build
```

Every scan receives image-hash, camera-basis, twelve-edge seam, metric-coordinate,
measured-floor and neighbor-ID checks. The validator reads actual GLB topology/hash.
`--source` additionally checks original E57 bytes, scan identities and poses. Imports
run source-bound validation before publication. Standalone checks without that argument
truthfully report `sourceVerified: false`.
`--source` also accepts the original ZIP and validates every member sequentially;
allow scratch space for its largest E57. Check `sourcePartCount` and source scan totals
against the archive inventory, including global node offsets for split exports.

For new imports, seam measurements are compared with original-image baselines measured
before image downsampling/re-encoding. Large inherited edge differences are explicit
warnings, not quietly reported as seamless. Added conversion error still fails. Older
packages without baselines retain strict absolute thresholds. Review `quality.json`
for all point/photo errors, floor support, point-to-mesh median/p95, graph components
and isolated scans. A stale receipt does not certify edited assets.
For any `cameraPointNodes` (older receipts call these `overviewOnlyNodes`), verify
its camera-position sphere and panorama, including direct first-person selection
from a measured neighbor and dollhouse access. Confirm it is excluded from inferred
floor-click targeting. These source limitations must remain in the delivered receipt.

## Browser tools

Use the host-provided browser/computer tool when available and follow its instructions.
Standalone Playwright helpers do not override a host restriction on shell-based browser
control. The following are runnable standalone/CI examples where that execution is allowed:

```sh
node .agents/scripts/project/verify-app.mjs --url 'http://localhost:3002/?config=/datasets/matterport/my-space/bootstrap.json' --screenshots
node .agents/scripts/matterport/verify-dataset.mjs --slug my-space --data-only
# Auto marker projection requires the development runtime:
node .agents/scripts/matterport/verify-dataset.mjs --slug my-space --url http://localhost:3001 --screenshots --marker-click auto
```

`verify-dataset` uses the development runtime accessor for spatial marker projection.
Production diagnostics are exposed in the canvas `data-sphr-state` attribute. Do not
count preloaded image requests as proof that a navigation completed.

Read-only diagnostic example after selecting the real scene tab:

```javascript
const snapshot = await tab.playwright.evaluate(() => {
  const canvas = document.querySelector('canvas');
  return JSON.parse(canvas?.getAttribute('data-sphr-state') || 'null');
});
// Check state.activeNodeId, state.viewMode, state.navigating, state.navigationError.
// Perform interactions through observed UI and the host's documented APIs.
```

## Observed acceptance

| Scenario | Required observation |
| --- | --- |
| Direct entry | Assets settle and scene opens automatically; no intro/start screen |
| Imported capture | Automatically enters free exploration; no guide/text toggle, Previous/Next, location dropdown or SPHR header label |
| Authored tour | Automatically starts guided; guide toggle and Next/Previous icons still work |
| Stationary panorama | Clear source photograph, correct level, registered walls/floors, no fog/vignette |
| Cube boundaries | Look up/down and across edges; architectural lines agree; disclose inherited source differences |
| Floor marker / floor surface | One real click changes active node/camera and settles; marker is on measured floor |
| Movement | Incoming images ready; no "Moving" label, black flash, triple ghost, reflective sliding or wall-crossing flight |
| Heading | Free node movement preserves look direction |
| Dollhouse | Actual bounds fit; photo-textured mesh; orbit and zoom work |
| Double-click | Surface/marker flies into a suitable scan at eye level; background flies back to current scan; inspect intermediate motion, late photo blend and settled pose |
| Single-click/drag | Does not unintentionally leave dollhouse |
| Coverage | Different rooms/ends and every connected component are reachable |
| Mobile | About 390 × 844; no heading/HUD overlap; actual navigation works |
| Failure | Missing incoming face keeps previous scene, reports error and allows a subsequent valid move |
| Memory | After traversal unpinned textures trim instead of growing without bound |

Inspect stairs, multiple floors, dark scans and missing-nadir cases when present; do not
invent them for a single-floor capture. All scans receive machine checks; state exactly
which scans were visually inspected. Claim all-scan browser traversal only if every scan
was entered and its settled active ID verified. Temporary QA configs may provide an
explicit authored sequence for exhaustive traversal without restoring removed product UI.
Remove them afterward and test the production exploration config separately.

For a data-only import, capture-specific review plus the existing production runtime is
appropriate. Shared runtime edits also require the Garden 3DGS demo, authored tours,
ordinary panorama movement and mobile layout. Repeat checks when changes warrant it.

## Receipt

Record source filename/hash/bytes, URL, scan/face counts and resolution, actual triangles,
atlas coverage, photo/mesh metrics, floor range, graph components, exact executed checks,
observed scenarios and limits. Save the capture report in ignored local/external records and retain the
machine JSON beside assets. Partial visual review must not be labeled exhaustive.
