# Harvard Computational Robotics Group Lab — migration review

Completed 2026-09-15 using the shared importer and production Next viewer.

[Open the scene](http://localhost:3002/?config=/datasets/matterport/harvard-robotics-lab/bootstrap.json).

## Source and reproducibility

- Download: `~/Downloads/mp_e57_Harvard-Computational-Robotics-Group-Lab_TkQg3fZoEaE.zip`
- ZIP: 1,269,218,716 bytes; full archive CRC check passed.
- Embedded `cloud_0.e57`: 1,669,568,512 bytes; declared E57 physical length matches.
- E57 SHA-256: `f87d5d33ebe338287464d5e491b6c5329c4f734215d7d8bbddd5c4ff657541b6`
- Extracted source: `../data/processed/harvard-robotics-lab/source/cloud_0.e57`.
- Published package: `public/datasets/matterport/harvard-robotics-lab/`.

Run from the Next repository:

```sh
npm run import:matterport -- \
  --e57 ~/Downloads/mp_e57_Harvard-Computational-Robotics-Group-Lab_TkQg3fZoEaE.zip \
  --slug harvard-robotics-lab --title 'Harvard Computational Robotics Group Lab'
npm run test:matterport -- public/datasets/matterport/harvard-robotics-lab
node .agents/scripts/matterport/report-package.mjs public/datasets/matterport/harvard-robotics-lab
```

The final import rebuilt images, measured-depth geometry, reduction, atlas and navigation
from the source. Source-bound validation passed before publication. No capture-specific
runtime transforms, fixed face permutations or manually placed floor markers were added.

## Measured package results

| Check | Result |
| --- | --- |
| Scan positions / cube images | 23 / 138 |
| Published image resolution | 2048 × 2048 |
| Actual GLB triangle count | 50,000 |
| GLB size | 9,963,996 bytes |
| Atlas | 4096 × 4096; 73.71% direct visible-camera coverage |
| Metric coordinate transformation error | 0 m |
| Worst per-scan median point/photo RGB error | 0.013072 on a 0–1 scale |
| Point-to-reduced-mesh distance | Median 0.01424 m; p95 0.08974 m |
| Measured camera heights | 1.57020–1.59614 m |
| Navigation graph | One 23-node component; no isolated nodes |
| Source-bound package validation | Passed, with one source-image seam warning |

Zero coordinate transformation error verifies consistent source-to-viewer units and poses;
it does not mean that the reduced surface has zero geometric error. The mesh distance
statistics describe sampled measured points relative to that surface. Unobserved atlas
regions retain source vertex colors.

## Source seam investigation and shared fix

The first import was correctly stopped by the old absolute seam gate on `scan-001`,
faces 0 and 2. Its derivative edge RGB median difference was 0.13071895, above 0.10.
Independent decoding and orientation of the original embedded photographs measured
0.12875817 on the same edge. The conversion difference was only 0.00196078.

Original photographs and the rendered ceiling were inspected. They contain fine ceiling
netting, bright lights and an existing blurred camera mask. The discrepancy was already
present in the source; correcting face order or imposing a scene rotation would damage
the calibrated result.

The generic converter now records twelve original-image edge measurements before output
encoding. Validation compares derived edges against those baselines, rejects added
conversion error, and explicitly warns about inherited source differences. Older packages
without baselines keep their strict absolute limits. No global threshold was relaxed.
The final package retains a `source-image-seam` warning for `scan-001` in `validation.json`.

## Browser review

The production viewer was exercised through the host browser tools:

- All 23 scans (`scan-000` through `scan-022`) were entered through real Next controls
  in a temporary, camera-only authored QA sequence. Each settled active node ID was
  checked. This also exercised the runnable authored-tour composer on real scene data.
- Scans 000–008 were traversed at a desktop viewport; 009–022 at 390 × 844.
- Detailed screenshots were inspected at scans 000, 001, 008, 011, 015 and 022, plus
  the dollhouse. This is representative visual inspection, not inspection of every
  direction in all 23 panoramas.
- The ceiling/source seam at scan 001 was reviewed against decoded source photographs.
- The actual exploration config showed Free Explore alone. The in-scene header contained
  only the scene title, with no location dropdown, SPHR label or guided-tour controls.
- A visible floor-marker click entered scan 011; the measured rings and laboratory
  photograph appeared aligned. Dollhouse double-click returned to eye-level photography.
- The textured reduced mesh fit the laboratory extent. Thin ceiling structures and some
  peripheral/glass geometry remain incomplete or fragmented in the reconstruction.
  This is a measured-depth, reduced surface, not a claim of watertight Matterport parity.
- Browser error logs were empty at the completed traversal check. Temporary QA config
  and tab were removed, and the viewport override was reset.

Stationary photographs were sharp after transition fading settled. Browser diagnostic
attributes are state snapshots, not per-frame traces; a stale `fading` or camera field
alone was not treated as a visual failure.

## Checks executed

- Complete ZIP/header preflight and two full imports (first stopped at the source seam;
  second completed after the generic baseline fix).
- Source-bound validation inside the final import; fresh all-scan package validation.
- Nine Python geometry/seam regressions, including source warnings, introduced conversion
  damage, missing source evidence and malformed baselines.
- Previous Loomis Observatory package validation passed with the updated shared validator.
- Production build and TypeScript checking passed.
- New package-report helper and `verify-dataset --data-only` passed on this real package.
- Authored-tour example generated the 23-stop QA config; invalid node IDs, source overwrite
  and existing-output overwrite were rejected, with the imported bootstrap unchanged.
- Four relevant skill files passed the skill-creator validator; Matterport reference links,
  Python undefined-name checks, JavaScript syntax, shell syntax and Git whitespace checks passed.

Standalone browser helpers were updated and syntax-checked; browser interaction in this
session used the host tool. No new shared runtime code was changed during this capture
import, so prior Garden/3DGS runtime verification was not repeated here.

## Reusable agent material

Start with [the Matterport skill](../.agents/skills/sphr-matterport/SKILL.md). It links
source discovery, complete import commands, camera/mesh contracts, validation, troubleshooting,
source-preserving reuse and runnable examples. Roles cover migration ownership, independent
geometry review, panorama integration and browser acceptance. The parent workspace's
`./.agents` links to the repository's single tracked `.agents` directory.

Durable machine receipts are `manifest.json`, `quality.json` and `validation.json` beside
the assets. Local logs are in `tmp/harvard-import.log`, `tmp/harvard-validation.log`,
`tmp/harvard-agent-validation.json`, `tmp/harvard-report.json`, `tmp/harvard-build.log`
and `tmp/observatory-regression.log`; these temporary files are not Git deliverables.
