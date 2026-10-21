# Matterport viewer archives → SPHR

When an E57 export is unavailable, a local `matterport-dl` archive can supply the
photographs, textured dollhouse geometry, camera poses, floor positions and neighbor
graph already exposed by the viewer. Raw depth and the original point cloud are not
included. The importer records `sphr-matterport-web-v1`, independently of E57 imports.

Download content you are authorized to archive using
[matterport-dl](https://github.com/rebane2001/matterport-dl), or with
`scripts/worker/matterport-link.mjs`, which the processing runner uses for customers' Matterport
links (below). Keep that archive outside `public`. Then use the existing Matterport Python environment:

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

Some source navigation graphs reference locations absent from their published model.
The importer stops by default. After reviewing the original prefetch, explicitly use
`--allow-unavailable-neighbors` to omit only those impossible edges. Every available
panorama and all existing edges between available scans remain unchanged. The missing
target IDs are retained in the nodes, manifest and source-bound validation receipt.
No substitute panorama or through-wall connection is created. Missing actual images,
camera poses or mesh assets still fail conversion.

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

## Downloading from a link

```sh
node scripts/worker/matterport-link.mjs https://my.matterport.com/show/?m=MODEL_ID /path/to/archive
```

The downloader asks Matterport's model graph (`/api/mp/models/graph`) for the model the way the
showcase asks for its prefetch: the default view and the sweeps tagged `showcase`, with the root model's
name and cover picture. The showcase page itself sits behind a bot check that turns scripts away at random;
the graph does not. It writes that data into `index.html` as a showcase page carries it, then fetches every
face at the best **available** skybox resolution (locked resolutions are never taken), the 50k DAM and the
textures its chunks name, the cover picture, and the Mattertags (`api/mp/models/graph_GetMattertags.json`)
with the photos Matterport hosts for them. Each file lands at its URL path, as matterport-dl stores it.

The graph signs file addresses for five minutes and refuses an expired one with 410, so the downloader reads
the graph again every two and a half minutes and once more for any file refused as expired. It contacts only
`*.matterport.com` over https, follows redirects by hand so every hop is checked, and stops at 20 GB, 20,000
files, 400 MB a file or an hour. A failed download leaves no archive. A 139-sweep space at 2k (654 MB) took
about six minutes on a home connection; the import then takes under a minute.

Sweeps the owner hid stay out of the graph's answer while the others still list them as neighbors, so link
imports run with `--allow-unavailable-neighbors`.

## Packages the runner publishes

The package uses the layout the processing runner and `publish.py` publish for imported (non
`sphr-package-v1`) packages: faces at `faces/<sweep>/face<N>.jpg` listed with their SHA-256 in
`manifest.imageManifest.groups`, the mesh at `mesh/<slug>-50k.glb` with its hash in `manifest.mesh`, and
`validation.json` with `passed: true`.

Enabled Mattertags become `space.space_data.tags` in the bootstrap: `id`, `title`, `description` (plain
text; markdown links become "label (address)"), `position` and `normal` in the viewer's frame (C·anchor,
C·stem normal), `color` as `#rrggbb`, `media` (`image`, `video` or `link` for Matterport's photo, video and
rich types) and `source: "matterport"`. A tag photo Matterport hosts is copied to `tags/<id>.<ext>` and
listed in `manifest.tagMedia`, which the runner and publisher ship with the faces. Media on other hosts keeps
its https address, the one kind of outside address `validate-package.mjs` accepts; media over plain http is
dropped. Imported tags are the space's defaults; edits its owner makes in the app replace them.

Do not send web packages through the E57-only validator or E57-specific publisher.
Local import does not upload the package. The ZIP package can be extracted into another
SPHR application's `public/` directory and indexed with `npm run scenes:index`.
