# Matterport batch — September 16, 2026

The public collection is [app.mused.com](https://app.mused.com/). Harvard and Loomis
Observatory retain their existing Private website visibility. Public asset storage
is independent of that viewer setting. This is an in-progress receipt; remaining
captures are published individually after validation and visual review.

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
| [Center for Hellenic Studies office/library](https://app.mused.com/s/d8c44fc46d28/main-office-and-library-center-for-hellenic-studies) | 75 | 450 | 49,999 | 0.00824 / 0.06417 | 70, 5 |
| [Temple 16 / Rosalila](https://app.mused.com/s/20e48f12b954/temple-16-and-rosalila-tunnels-copan-ruinas) | 723 | 4,338 | 49,934 | 0.03166 / 0.14309 | 719, 3, 1 |
| [Temple of Artemis](https://app.mused.com/s/0d878986afb7/temple-of-artemis) | 122 | 732 | 49,932 | 0.01853 / 0.14264 | 3, 119 |
| [Center for Hellenic Studies, Greece](https://app.mused.com/s/60d7bc0165f2/harvard-universitys-center-for-hellenic-studies-greece) | 80 | 480 | 49,987 | 0.01119 / 0.10208 | 79, 1 |
| [Las Pinturas / San Bartolo](https://app.mused.com/s/553b789c052b/las-pinturas-san-bartolo) | 94 | 564 | 49,895 | 0.02538 / 0.52841 | 94 (one node has no outgoing edge) |

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
| Hellenic Studies office/library | Desktop/mobile 000 → 052; textured dollhouse → library 036; separate office component 013 → 014 on mobile; live anonymous mobile entry verified |
| Temple 16 / Rosalila | Mobile and desktop 000 → 007; dollhouse → 469 / 380; all three components sampled; 175, 176, 177, 462, 550, 640, 700 reviewed; direct camera-sphere click 177 → 175 |
| Temple of Artemis | Entry 003; desktop floor click → 084; dollhouse → 069; mobile → 070; separate component 000 → 001; repaired mobile framing and dollhouse → 063; live anonymous mobile overview verified |
| Hellenic Studies Greece | Entry 001; desktop → 000; dollhouse → 067; mobile → 071; isolated balcony 062 inspected; live anonymous mobile entry verified |
| Las Pinturas / San Bartolo | Mobile floor click 000 → 001; desktop → 003; desktop/mobile dollhouse; mobile dollhouse 088 → 053; sparse scan 033 and source-seam cases 060 / 088 inspected |

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

- Temples 20, 22 and 26: all 744 scans from both E57 parts have been fused;
  full measured surface extraction is running on temporary Mac storage.
- Sculpture Museum at Copán: complete 337-scan export is processing.
- KSI Auto Parts: completed ZIP is extracting for full import.
- The unnamed `cloud_0-001.e57` contains 131 scans; its title and complete-export
  identity need clarification. Its GUIDs do not overlap the Greece capture.
- An additional download remains active. Amaryl has about 5.4 GiB free, so newer
  outputs use `/Users/lrh/Projects/sphr/.matterport-work` temporarily, with links
  from the normal dataset and processed paths. These files are not yet relocated
  to the external drive. Original exports remain intact.

## Large-site mobile framing

Runtime commit `6d6859b` removes the fixed 150 m orbit distance cap that clipped
large surveys on portrait screens. The existing aspect-aware bounds calculation
now controls the complete camera pose. Artemis needs about 688.19 m at 390 × 844;
its projected horizontal extent now fits inside the viewport. Actual mobile
review confirmed the full temple and a double-click return to scan 063.

All 13 navigation/audio/framing regressions, typecheck and the production build
passed. The Garden regression still renders 3,810,048 splats, advances the mobile
white Next button from point 0 → 1, and switches to free exploration and orbit.
The runtime is deployed on `struct25`. Publisher commit `1c2e225` also safely
merges simultaneous catalog updates after asset upload; all 45 Python tests pass.

## Large-surface reduction repair

Pipeline commit `5c3150e` bounds QEM's working geometry, repairs non-manifold edges
by removing their smallest excess triangles without moving vertices, and saves
source-bound intermediate reduction checkpoints. It retains successful QEM progress
even above the requested ceiling. Floors still use the original full measured mesh.
The actual Copán retry needed two metric clustering passes (0.13678 and 0.20517 m),
then repair of 411,684 non-manifold edges before ordinary QEM met the ceiling.
The repair removed 18.16% of the clustered surface's triangle area; source-distance
measurements and visual review are necessary to interpret the remaining geometry.

An earlier attempt to repair topology by repeatedly enlarging spatial cells was
stopped before publication because 1.314 m cells were too coarse for tunnels.
The accepted implementation avoids that topology strategy. All 43 current Python
regressions pass, including metric shape preservation, problematic fragments and
interrupted/source-bound reduction recovery. A same-volume hard-link copy of the
full Copán checkpoint was retained through visual review, then its 3.34 GB was
released after live acceptance. All original source ZIPs remain intact.

The completed office/library, Artemis, Greece and Las Pinturas output packages and
processed metadata have now moved from temporary Mac storage to amaryl. Every file
was copied and reread for SHA-256 verification before removing its internal copy;
compatibility links remain at both expected roots. New original downloads and the
still-running larger imports remain on the Mac because external capacity is limited.
