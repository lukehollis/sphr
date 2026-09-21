# Matterport viewer archives → SPHR

When an E57 export is unavailable, a local `matterport-dl` archive can supply the
photographs, textured dollhouse geometry, camera poses, floor positions and neighbor
graph already exposed by the viewer. Raw depth and the original point cloud are not
included. The importer records `sphr-matterport-web-v1`, independently of E57 imports.

Download content you are authorized to archive using
[matterport-dl](https://github.com/rebane2001/matterport-dl). Keep that archive outside
`public`. Then use the existing Matterport Python environment:

```sh
npm run import:matterport-web -- \
  --archive /path/to/matterport-dl/downloads/MODEL_ID \
  --slug my-space
```

The title comes from the source; `--title` overrides it. Conversion is offline and
fails if any required panorama face, mesh chunk, texture, pose or neighbor is missing.
It copies the highest available complete cube images without re-encoding, preserves
every triangle/UV in the available 50k DAM mesh, embeds textures in GLB, and creates the
standard exploration bootstrap. `--public-root` selects another staging/output root.
The implementation currently requires one available 50k DAM mesh and its high-quality
JPG texture set. Unsupported geometry formats fail explicitly.

Coordinates use meters and `[x,z,-y]`. Panorama orientation follows Showcase's
`fromVisionSweepQuaternion`: change coordinate basis, then its local Y quarter-turn.
The archived `late.js` sweep-textures loader maps cube images `[2,4,0,5,1,3]` into a
WebGL cubemap; SPHR's existing six inward-facing planes accept the original face order.
No source-specific rotation adjustments or viewer branches are used. The minimal DAM
wire decoder follows the layout documented by
[rogue_matterport_archiver](https://github.com/willowpsychology/rogue_matterport_archiver).

The complete source binding and output hashes live in `manifest.json`. Validation checks
all source images, source poses/floors/edges, GLB vertices/triangles/UVs and twelve cube
edges per node before swapping the staged package into place. Existing scene IDs persist.
A failed staging directory is retained for diagnosis; resolve or move it before retrying.
The catalog supports mixed E57 and viewer archive packages.

```sh
npm run import:matterport-web -- \
  --validate public/datasets/matterport/my-space \
  --archive /path/to/matterport-dl/downloads/MODEL_ID

../.venv-matterport/bin/python scripts/matterport/audit_web_alignment.py \
  public/datasets/matterport/my-space \
  --output public/datasets/matterport/my-space/alignment.json

../.venv-matterport/bin/python -m unittest discover \
  -s scripts/matterport -p test_web_archive.py -v
```

The alignment audit raycasts each panorama against the delivered textured GLB and
compares fixed quarter-turn negative controls. It detects registration mistakes that
seam checks alone miss. This establishes consistency between viewer assets, not
accuracy against raw scan measurements. Browser acceptance still requires actual
navigation, overview entry, panorama inspection and mobile review.

Do not send web packages through the E57-only validator or E57-specific publisher.
Local import does not upload the package. The ZIP package can be extracted into another
SPHR application's `public/` directory and indexed with `npm run scenes:index`.
