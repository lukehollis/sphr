# Full import workflow

## 1. Locate and bind the source

Use the actual `~/Downloads` directory. Compare filenames, modification times and
existing manifests; do not assume the last imported ZIP is the new one. Incomplete
`.crdownload`/`.download` files or growing files are not ready. Ask which capture only
if inspecting the candidates cannot resolve the user's reference.

```sh
python3 .agents/scripts/matterport/inspect-export.py --downloads ~/Downloads
python3 .agents/scripts/matterport/inspect-export.py --source /captures/export.zip --check-crc
```

The helper is read-only. ZIP CRCs establish archive integrity, not correct geometry.
A raw E57 must match its `ASTM-E57` magic and declared physical file size. The converter
rechecks completeness, extracts exactly one E57 to a fixed filename and hashes it.

## 2. Environment and resources

Check free disk space for raw extraction, staged/previous assets and intermediate
geometry. Observed exports have contained 1.67 GB and 3.63 GB E57s; larger captures
can require substantially more memory/storage. Never run concurrent imports of the
same slug: they share its staging directory.

```sh
python3 -m venv .venv-matterport
.venv-matterport/bin/pip install -r scripts/matterport/requirements.txt
```

Reuse an existing valid environment. The Node entrypoint selects
`SPHR_MATTERPORT_PYTHON`, repository `.venv-matterport`, parent `.venv-matterport`, then
`python3`, and checks NumPy, Pillow, pye57, Open3D, trimesh, SciPy and xatlas.
Source arguments are relative to the caller's working directory; absolute paths are clear.

## 3. Convert the entire capture

```sh
npm run import:matterport -- --e57 /captures/export.zip --slug my-space --title 'My Space'
```

Standard `mp_e57_Title_ModelID.zip` names can supply inferred title/slug. For an unnamed
`cloud_0.e57`, supply meaningful values. The default full path performs:

1. Complete-file check and source SHA-256 binding.
2. Every scan and its six GUID-associated pinhole cameras; central-camera/intrinsic checks.
3. Pose-derived cube assignment and quarter turns; 2048² delivered JPG faces.
4. All measured points into 512² depth faces; per-scan point/photo registration QA.
5. TSDF fusion at 0.035 m; measured floors and conservative sightline navigation graph.
6. Quadric reduction to ≤50,000 triangles; xatlas unwrap and 4096² photo atlas.
7. Bootstrap, preview, source/asset manifest, quality and validation receipts.
8. Validate staging, swap final package, retain `.my-space.previous`, update library index.

Log the command and exit status. Progress distinguishes images, fusion, surface extraction
and texture baking. Atlas work can be quiet: inspect process/log status instead of
launching a duplicate import. Continue documentation or read-only work while it runs.

## 4. Resolution and reuse

| Option | Default | Reason to change |
| --- | --- | --- |
| `--target-triangles` | 50000 | User's different geometry budget |
| `--voxel-size` | 0.035 m | Measured missed detail or excessive resource use |
| `--depth-size` | 512 | Depth sampling/reconstruction tradeoff |
| `--face-size` | 2048 | 4096 for full typical source image resolution |
| `--atlas-size` | 4096 | Overview texture/detail budget |
| `--public-root` | repository `public` | Isolated complete reproducibility run |
| `--processed-root` | parent `data/processed` | Separate raw/metadata storage |

`--skip-images` and `--skip-mesh` require a matching source hash and calibrated v2
package. Reused assets do not acquire newly requested resolutions or algorithm changes.
After changing calibration, rebuild images, mesh/atlas and QA. A new capture always
starts with a full run. Failed staging is useful diagnosis; it is not a published package.
Do not edit a JPG/mesh and bless a replacement hash: rebuild from source.

## 5. Serve the real scene

```sh
npm run typecheck
npm run build
npm run start -- --port 3002
```

Inspect existing listeners before reusing a port; never kill an unrelated process.
Restart your production server after publishing new directories or rebuilding bundles
if it still serves stale files. Avoid concurrent builds that share an active server's
build output.

Open the `/s/<sceneId>/<title-slug>` URL printed by the importer. `/` lists imports and
`/library` redirects there; `/?demo=garden` selects the authored Gaussian-splat demo.
Legacy `/?config=/datasets/matterport/my-space/bootstrap.json` links remain supported.
Complete [verification.md](verification.md). Preserve manifest `sceneId` across reimports
and backups. Use `npm run scenes:index` to backfill older packages without reconversion.

## 6. Handoff

Keep command/log, manifest, quality and validation receipts, and observed browser review.
Use [examples.md](examples.md) to report actual counts and metrics. The manifest source
hash identifies the extracted E57, not its compressed ZIP. Local import does not imply
permission to upload or publicly publish the capture.
