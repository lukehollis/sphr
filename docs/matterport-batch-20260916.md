# Matterport batch — September 16, 2026

The public collection is [app.mused.com](https://app.mused.com/). Harvard and Loomis
Observatory retain their existing Private website visibility. Public asset storage
is independent of that viewer setting. This is an in-progress receipt: the two
large Copán captures are not yet delivered.

## Delivered captures

All rows below have source-verified validation receipts, six 2048 × 2048 calibrated
photographs per scan, a 4096-pixel photo atlas, and an actual GLB below or equal to
50,000 triangles. Distances measure sampled source points against the delivered
reduced mesh. Exact meter conversion does not imply a perfect reconstruction.

| Capture | Scans | Faces | Triangles | Median / p95 mesh distance (m) | Navigation component sizes |
| --- | ---: | ---: | ---: | --- | --- |
| [Holy Belt](https://app.mused.com/s/faefedd05636/chapel-of-the-holy-belt-st-stephens-cathedral-prato) | 21 | 126 | 50,000 | 0.01138 / 0.05800 | 21 |
| [Baroncelli](https://app.mused.com/s/91200a29b18b/baroncelli-chapel-basilica-of-santa-croce-florence) | 24 | 144 | 50,000 | 0.01011 / 0.05810 | 24 |
| [Chiesa dei Domenicani](https://app.mused.com/s/8ac2c04a2cc6/chiesa-dei-domenicani-bolzano) | 25 | 150 | 50,000 | 0.00993 / 0.04290 | 25 |
| [Scrovegni](https://app.mused.com/s/86bb09b8a414/scrovegni-chapel-padua) | 33 | 198 | 50,000 | 0.01498 / 0.07177 | 33 |
| [Rinuccini](https://app.mused.com/s/7914d57eba5a/rinuccini-chapel-basilica-of-santa-croce-florence) | 81 | 486 | 49,999 | 0.06376 / 0.52609 | 1, 77, 1, 2 |
| [Great Sphinx](https://app.mused.com/s/284896856ea2/great-sphinx-of-giza) | 50 | 300 | 49,738 | 0.03387 / 0.86145 | 2, 1, 41, 1, 4, 1 |
| [Meresankh III](https://app.mused.com/s/49ea8cec19b9/tomb-of-queen-meresankh-iii-giza) | 24 | 144 | 50,000 | 0.00627 / 0.02581 | 24 |
| [Great Pyramid](https://app.mused.com/s/0b7dabf2e410/inside-the-great-pyramid-of-giza-khufu) | 145 | 870 | 50,000 | 0.01308 / 0.10851 | 125, 20 |
| [Xultun](https://app.mused.com/s/ba3c612e055a/xultun) | 18 | 108 | 49,999 | 0.01258 / 0.05672 | 18 |

## Actual browser review

Desktop and 390 × 844 mobile observations use the real viewer and real clicks.
Active scan IDs were read from the canvas diagnostics after movement settled.
These are sampled visual checks, not an assertion that every scan was visited.

| Capture | Observed scans and interactions |
| --- | --- |
| Holy Belt | 000 → 007 single click; dollhouse → 004; mobile 004 → 007 |
| Baroncelli | 000 → 004 single click; dollhouse → 011; clear mobile entry at 000 |
| Chiesa | Mobile entry 000; desktop → 017; dollhouse → 018 |
| Scrovegni | Floor between markers 000 → 001; dollhouse → 032; mobile panorama |
| Rinuccini | 002 → 007; all four components sampled at 002, 000, 058, 065; live entry 002; mobile dollhouse → 037 |
| Sphinx | Live mobile 003 → 004; dollhouse → 047; all six components sampled at 003, 000, 002, 036, 038, 042 |
| Meresankh | Mobile floor click 000 → 009; both dollhouse levels; double-click lower chamber → 020 |
| Pyramid | Desktop/mobile 000 → 001; dollhouse → 101; source-floor cases 043, 044, 045; separate exterior component at 144; live mobile entry 000 |
| Xultun | Mobile 000 → 010; revised desktop/mobile dollhouse framing; double-click ring → 016; desktop single click 016 → 015 |

Temporary local guided sequences were used to inspect separated graph components.
Published imports remain ordinary free exploration. Sphinx's outdoor mesh and
Rinuccini's scaffolding contain fragmented surfaces and larger reduction errors;
the panoramas preserve the calibrated source photographs. Components are reported
instead of adding paths through walls to make a graph connected.

Pyramid scan 044 has no supported floor measurement. Its original camera and six
images remain intact. A sphere at its camera position is directly selectable in
first person and dollhouse. Real clicks from 043 → 044 and 045 → 044 were verified;
the node is excluded from inferred floor-click targeting. The older Pyramid receipt
calls this `overviewOnlyNodes`; the deployed viewer now supports both direct modes.
See [source-floor verification](source-floor-navigation-verification.md).

Xultun includes sparse distant geometry around a compact passage. Its mesh span is
9.17 times its measured camera span. Generic overview framing now starts around the
padded survey bounds when that ratio exceeds four, retaining all cameras, floors,
and original mesh geometry for orbit/zoom. This improves the initial view without
claiming that the distant fragments have been reconstructed or removed. The other
ten original/local E57 captures have ratios below four and keep full mesh framing.

## Pipeline and storage

The reusable importer validates every E57 member of a split ZIP, retains scan GUIDs
and camera poses, shares fusion across parts, checks image/point registration, and
enforces the actual mesh ceiling. Source-bound geometry checkpoints allow surface
processing to retry without re-reading every scan. Floor refinement uses measured
full-resolution geometry before reduction. Navigation visibility currently uses the
delivered reduced mesh, so it can still differ from full-resolution sightlines.

All completed imports ran source-bound validation. Python regressions passed
(34 tests), navigation regressions passed, and the real production build passed
with datasets on the external drive. Runtime commit `4d40155` was deployed to
`struct25`; pipeline commit `29bdc86` is pushed. After the framing change, all 13
navigation/audio/framing regressions, typecheck and production build passed. The
Garden browser regression retained 3,810,048 rendered splats and real mobile guided
navigation from point 0 → 1 with the white Next button.

Original ZIPs, processed metadata, panoramas, GLBs and checkpoints live at
`/Volumes/amaryl/spaces`; see [local storage](local-capture-storage.md).
The relocation moved 14 completed ZIP originals and the existing processed/public
tree, totaling 169,333,522,881 verified bytes including two original partial files.
The relocation log records SHA-256 and byte counts before internal copies were
removed. Completed ZIP paths and dataset roots retain compatibility symlinks.
The two original partial downloads remain incomplete, with their original copied
prefixes verified even after the browser appended bytes. Additional downloads
started later on the Mac and need external capacity before relocation.

Full local source identities, member hashes, metrics and status are retained in
`/Volumes/amaryl/spaces/migration-records/batch-packages.json`, the relocation
JSONL, and each package's `manifest.json`, `quality.json`, and `validation.json`.
These private receipts and raw sources are not uploaded to the public asset bucket.

## Still processing

- Temple 16 / Rosalila: both source parts and all 723 scans are validated; reduction
  of the 113,802,391-triangle measured checkpoint is running. No final package yet.
- Temples 20, 22 and 26: original split ZIP retained; import held for external capacity.
- A new Center for Hellenic Studies export finished after the original batch and
  was also moved and verified externally. Its import has not started. Further
  arrivals include the Hellenic Studies Greece ZIP, Las Pinturas / San Bartolo ZIP
  and a raw `cloud_0-001.e57`, while three downloads remain active on the Mac.
  The external drive has about 5.4 GiB free. These newer files need additional
  capacity and are not reported as relocated or migrated.
