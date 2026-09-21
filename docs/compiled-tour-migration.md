# Compiled guided tours → native SPHR

Some older tours were published as static JavaScript bundles. Their authored story
may be newer than the database export. Keep an inventory of release names, object
timestamps and hashes outside Git. Select the latest complete release of each
distinct story/language; a newer SDK or development build is not automatically a
newer story. Preserve an existing scene ID when updating that same story.

## Extract without executing

```sh
node scripts/legacy/extract-bundle.mjs /archive/release/main.bundle.js /archive/source.json
```

The extractor parses JavaScript syntax, reads literal `JSON.parse` arguments and
requires exactly one authored story. It never evaluates the bundle. Source maps can
then establish embedded-model transforms, their stop visibility schedules, overlays,
media origins and portal destinations. Keep those source-specific facts in an ignored
binding JSON, not in runtime branches or committed examples.

## Bind to a native capture

```sh
python3 scripts/legacy/compiled_tour.py \
  --source /archive/source.json \
  --native /captures/example/bootstrap.json \
  --binding /archive/binding.json \
  --output /staging/tours/aaaaaaaaaaaa
```

Binding fields:

```json
{
  "tourId": "aaaaaaaaaaaa",
  "title": "An authored story",
  "mediaBase": "https://assets.example.com",
  "originMap": {"https://old.example.com": "https://assets.example.com"},
  "nodeAliases": {"original-location-id": "scan-001"},
  "sceneGraph": [{
    "id": "reconstruction", "type": "model",
    "file": "https://assets.example.com/reconstruction.glb",
    "position": [0, 0, 0], "rotation": [0, 0, 0], "scale": 1
  }],
  "modelsByStop": {"2": ["reconstruction"]},
  "annotationGraph": [],
  "annotationsByStop": {},
  "pointOverrides": {}
}
```

Stop indexes in the binding are zero-based. Model rotations use radians; source
camera rotations use degrees. Read actual source code to establish these units.
Use the source scan GUID, or a source-proven location-ID alias, to select each scan.
Never substitute a nearest scan. Verify corresponding camera positions in the source
coordinate system before reusing world-space objects and camera angles. The converter
preserves the native capture's calibrated geometry and rejects missing scans/models.

Use a verified native viewer archive, following the source binding described in
[legacy recovery](legacy-recovery.md), when an E57 is unavailable.
A story bundle alone does not contain its Matterport panoramas. If its hosted model
has disappeared and no capture archive exists, retain the extracted story and report
the missing source. Do not publish a broken tour or imply that a vendor iframe is a
native migration.

## Assets and acceptance

Copy referenced photos, video, audio, annotations and GLBs to the deployment's own
asset host. Use content hashes for immutable paths, preserve GLB external resources,
and rewrite only asset URLs. Keep original source/binding receipts outside public
directories. Check every stop's cube faces and every model/media URL, including CORS
for the actual deployed viewer origin. YouTube embeds are documents, not video files;
they do not require asset CORS. External video playback still requires its provider. Google place/view maps retain their location, zoom and satellite mode through a keyless embed; archived API keys may be restricted to a retired domain.

Inspect real entry, Next/Previous, overview and return, embedded objects and media,
and narrow mobile layouts. A network receipt alone is not visual verification.
Do not drop authored MODEL stops or replace their model selections with the scan mesh.

## Publish

Each ID-named folder needs `bootstrap.json`, `preview.jpg`, a `manifest.json` containing
`sceneId`, and `validation.json` with `passed: true` and current SHA-256 hashes under
`files.bootstrap.json` and `files.preview.jpg`. The surrounding `index.json` contains
the regular `spaces` array with each entry's `hasGuidedTour: true`. This explicit flag
distinguishes authored stories from generated scan waypoints; old database tour entries
remain recognized through their legacy identity.

```sh
python3 scripts/legacy/publish_tours.py \
  --directory /staging/tours --bucket my-assets --prefix sphr \
  --origin https://assets.example.com --dry-run
```

Remove `--dry-run` after acceptance. Upload native capture/model/media assets first.
The publisher uploads immutable bootstraps/previews before merging the current remote
catalog with a generation guard. It never changes scene visibility. Enable only the
intended new public stories through the normal admin controls; preserve private source
spaces and their private tour variants. Preserve administrator title/start-view edits.

Checks:

```sh
node --test scripts/test-compiled-bundle.mjs scripts/test-hosting.mjs
python3 -m unittest discover -s scripts/legacy -p test_compiled_tour.py -v
npm run typecheck
npm run test:navigation
npm run build
```
