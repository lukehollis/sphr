# Runnable examples

Run from the Next repository. Examples reference real imports; they do not create
placeholder panoramas or substitute synthetic data for conversion.

## Inspect a download without extraction

```sh
python3 .agents/scripts/matterport/inspect-export.py --downloads ~/Downloads
python3 .agents/scripts/matterport/inspect-export.py \
  --source ~/Downloads/mp_e57_Harvard-Computational-Robotics-Group-Lab_TkQg3fZoEaE.zip \
  --check-crc --sha256
```

The filename above is the real second validation capture. Replace it with the discovered
source for other work. `inputFileSha256` hashes the supplied ZIP or E57; the converter's
`manifest.sourceSha256` always identifies the extracted E57. The preflight never unzips
into arbitrary archive paths or changes source bytes.

## Import and read the receipts

```sh
npm run import:matterport -- \
  --e57 ~/Downloads/mp_e57_Harvard-Computational-Robotics-Group-Lab_TkQg3fZoEaE.zip \
  --slug harvard-robotics-lab --title 'Harvard Computational Robotics Group Lab'
npm run test:matterport -- public/datasets/matterport/harvard-robotics-lab
node .agents/scripts/matterport/report-package.mjs public/datasets/matterport/harvard-robotics-lab
```

`report-package.mjs` reads actual receipts and checks the current mesh hash. It reports
scan/face counts, face sizes, triangle count, bounds, texture coverage, mode, scale/photo/
mesh errors, measured height range, graph components, warnings and source-verification
status. It is not a replacement for fresh `validate.py` source/image validation.

## Optional authored tour from an imported scene

Only use this when a tour is requested or as an explicitly temporary QA fixture. The
normal import stays in exploration mode. Read actual node IDs from its bootstrap before
choosing stops. For the real Harvard import, this is a minimal two-stop authored example:

```json
[
  { "nodeUUID": "scan-000", "text": "Robotics lab entrance" },
  { "nodeUUID": "scan-011", "text": "Laboratory work area" }
]
```

Save those user-authored stops to a local JSON file, then:

```sh
node .agents/skills/sphr-matterport/examples/create-guided-tour.mjs \
  --input public/datasets/matterport/harvard-robotics-lab/bootstrap.json \
  --stops /path/to/authored-stops.json \
  --out public/configs/lab-walkthrough.json --title 'Lab walkthrough'
```

The script validates all node IDs and numeric camera values, preserves real asset URLs,
scene graph and source camera defaults, sets `mode: "guided"`, and writes a **new** config.
It refuses to replace the source bootstrap or an existing output. Text is supplied tour
content, not evidence extracted from an E57. Open
`/?config=/configs/lab-walkthrough.json` after the server recognizes the new file.

For exhaustive visual QA, create stops from every actual node with no invented narrative:

```javascript
// Node.js; write only to a clearly identified local QA file.
import { readFile, writeFile } from 'node:fs/promises';
const input = JSON.parse(await readFile('public/datasets/matterport/harvard-robotics-lab/bootstrap.json', 'utf8'));
const stops = input.space.space_data.nodes.map(node => ({ nodeUUID: node.uuid }));
await writeFile('tmp/harvard-qa-stops.json', JSON.stringify(stops, null, 2), { flag: 'wx' });
```

Feed that file to the same composer and use the actual Next button to visit each scan.
Check settled active IDs rather than resource requests. Remove the QA config afterward;
do not change the real import to guided just to obtain traversal controls.

## Read calibrated geometry in Python

Use the configured importer environment:

```python
import sys
sys.path.insert(0, 'scripts/matterport')
import numpy as np
from geometry import C, camera_face_assignment
from scipy.spatial.transform import Rotation

# Supply measured E57 scan and image rotations from their source pose records.
def calibrated_node(scan_rotation_wxyz, image_rotations_wxyz):
    def matrix(wxyz):
        w, x, y, z = wxyz
        return Rotation.from_quat([x, y, z, w]).as_matrix()
    group, assignments = camera_face_assignment(
        matrix(scan_rotation_wxyz), [matrix(q) for q in image_rotations_wxyz]
    )
    return Rotation.from_matrix(group).as_quat().tolist(), assignments
```

This calls the real shared calibration code. It does not prescribe a fixed face order
for arbitrary source images. See [geometry.md](geometry.md) for plane bases and units.

## Read-only production diagnostics

After using the host browser tool to load and enter the scene:

```javascript
const snapshot = await tab.playwright.evaluate(() =>
  JSON.parse(document.querySelector('canvas').getAttribute('data-sphr-state'))
);
// state.activeNodeId: rendered location; state.navigating: loading/movement in progress.
// navigation: visible candidate IDs; textures: current/pinned count; sceneGraph: mesh state.
```

These are diagnostics, not an interaction API. Use actual browser controls for navigation.
Camera values in the attribute are snapshots at state emission, not a continuous frame log.
