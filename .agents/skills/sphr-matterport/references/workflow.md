# Full import workflow

## 1. Locate and bind the source

Use the actual download location and any configured capture archive. This workstation
stores exports at `/Volumes/amaryl/spaces/exports`; the previous Downloads paths are
symlinks. Read [local capture storage](../../../../docs/local-capture-storage.md)
before changing storage locations or working with the large split captures.
Compare filenames, modification times and
existing manifests; do not assume the last imported ZIP is the new one. Incomplete
`.crdownload`/`.download` files or growing files are not ready. Ask which capture only
if inspecting the candidates cannot resolve the user's reference.

```sh
python3 .agents/scripts/matterport/inspect-export.py --downloads ~/Downloads
python3 .agents/scripts/matterport/inspect-export.py --source /captures/export.zip --check-crc
```

The helper is read-only. ZIP CRCs establish archive integrity, not correct geometry.
A raw E57 must match its `ASTM-E57` magic and declared physical file size. The converter
rechecks completeness and reads every E57 member in filename order. Split exports
receive global scan IDs and a single fused scene. Each part is extracted to a fixed
cache filename, checked against the ZIP CRC, hashed, and matched to original poses.
Never import only `cloud_0.e57` from a multi-part archive.

## 2. Environment and resources

Check free disk space for raw extraction, staged/previous assets and intermediate
geometry. Copán exports contain multiple E57 parts as large as 48.6 GB, and thousands
of delivered images. Account for the largest extracted part plus generated assets,
intermediate geometry and headroom. Never run concurrent imports of the
same slug: they share its staging directory.

```sh
python3 -m venv .venv-matterport
.venv-matterport/bin/pip install -r scripts/matterport/requirements.txt
```

Reuse an existing valid environment. The Node entrypoint selects
`SPHR_MATTERPORT_PYTHON`, repository `.venv-matterport`, parent `.venv-matterport`, then
`python3`, and checks NumPy, Pillow, pye57, Open3D, trimesh, SciPy, xatlas and fast-simplification.
Source arguments are relative to the caller's working directory; absolute paths are clear.

## 3. Convert the entire capture

```sh
npm run import:matterport -- --e57 /captures/export.zip --slug my-space --title 'My Space'
# For large archives, release each verified extraction cache after integrating it:
npm run import:matterport -- --e57 /captures/export.zip --slug my-space --title 'My Space' --discard-extracted-source
# When the largest raw part fits but its images would fill the disk:
npm run import:matterport -- --e57 /captures/export.zip --slug my-space --title 'My Space' --discard-extracted-source --buffer-part-images
# Keep original exports, metadata and final scenes on a mounted drive, using a separate scratch disk:
npm run import:matterport -- --e57 /captures/export.zip --slug my-space --title 'My Space' --extraction-root /scratch/e57 --discard-extracted-source
```

Standard `mp_e57_Title_ModelID.zip` names can supply inferred title/slug. For an unnamed
`cloud_0.e57`, supply meaningful values. The default full path performs:

1. Complete-file check and source SHA-256 binding.
2. Every scan and its six GUID-associated pinhole cameras; central-camera/intrinsic checks.
3. Pose-derived cube assignment and quarter turns; 2048² delivered JPG faces.
4. All measured points into 512² depth faces; per-scan point/photo registration QA.
5. TSDF fusion at 0.035 m across all parts; floor refinement against the full measured surface.
6. Enforced quadric reduction to ≤50,000 triangles; sightline graph, xatlas unwrap and 4096² photo atlas.
7. Bootstrap, preview, source/asset manifest, quality and validation receipts.
8. Validate staging, swap final package, retain `.my-space.previous`, update library index.

Entry uses the first navigable scan in the largest measured connected area. An
isolated scan at the beginning of an export must not strand the initial visitor.
All scans, including separate areas, remain available through dollhouse entry.

Log the command and exit status. Progress distinguishes images, fusion, surface extraction
and texture baking. Atlas work can be quiet: inspect process/log status instead of
launching a duplicate import. Continue documentation or read-only work while it runs.

`--buffer-part-images` keeps one part's encoded JPEGs in RAM, capped at 12 GiB, while
fusion reads them directly. It flushes byte-identical files only after that part's
source validation and extraction-cache release. This requires a ZIP and
`--discard-extracted-source`; budget RAM for both the buffered JPEGs and fusion.
The original archive remains intact. It does not lower face resolution or JPEG quality.

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
| `--extraction-root` | processed `<slug>/source` | Temporary raw E57 caches on a separate disk; also configurable with `SPHR_MATTERPORT_EXTRACTION_ROOT` |

`--skip-images` and `--skip-mesh` require a matching source hash and calibrated v2
package. Image reuse can also use a matching staged v2 manifest after a later mesh
validation failure. The next full validation rechecks all image hashes and poses;
staging itself never counts as a successful import. Multi-part exports require a full
import and reject both reuse flags. Reused assets do not acquire newly requested resolutions or algorithm changes.
After changing calibration, rebuild images, mesh/atlas and QA. A new capture always
starts with a full run. Failed staging is useful diagnosis; it is not a published package.
Do not edit a JPG/mesh and bless a replacement hash: rebuild from source.

After all source parts have been verified and fused, the importer saves a private
`geometry-checkpoint` beneath the processed directory. If floor refinement, reduction,
texture baking or final validation fails afterward, retry with `--resume-geometry`
and the same source/slug/calibration settings. This verifies the original archive hash,
the input poses, full measured mesh and point samples before repeating surface work.
It never resumes a partial fusion. All final image/geometry checks still run; the
checkpoint is removed only after successful publication. Changing source bytes,
voxel size, depth/face resolution or calibration requires a full import.

Surface reduction also saves each successful intermediate pass atomically in that
checkpoint. Its receipt binds the intermediate PLY hash, measured-source hash,
algorithm version, triangle budget and reduction history. `--resume-geometry` reuses
that progress after verifying the original source and full fusion checkpoint; it
still refines floors against the full measured mesh. A changed/corrupt reduction
checkpoint fails explicitly. Preserve it for diagnosis; do not edit its hashes or
repeat the expensive original fusion to work around a reduction failure.

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
For renamed downloads, the importer recognizes an exact set of existing scan GUIDs
and preserves that capture's storage slug and scene ID. Partial overlaps do not match.
Duplicate identities or scan GUIDs fail explicitly.

For an authorized hosted publication, run `npm run scenes:publish -- --slug my-space`.
It uploads immutable runtime assets before merging the remote catalog. On app.mused.com,
new IDs default to Private: sign in at `/admin` and enable Public for the requested
spaces. Preserve all other visibility settings. The public bucket remains public;
this setting controls the website viewer. See `docs/mused-hosting.md`.

## 6. Handoff

Keep command/log, manifest, quality and validation receipts, and observed browser review.
Use [examples.md](examples.md) to report actual counts and metrics. The manifest source
hash identifies the extracted E57 for a single-part export. Multi-part manifests bind
the ordered member names, sizes and SHA-256 hashes in `sourceParts`; `sourceSha256`
is the hash of that canonical binding. Neither is the compressed ZIP hash.
`--discard-extracted-source` deletes only checked derived caches after successful
part processing; the original ZIP/raw E57 is always preserved. Local import does not imply
permission to upload or publicly publish the capture.
