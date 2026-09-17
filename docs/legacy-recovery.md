# Recovering an earlier SPHR collection

The recovery tools move the original collection into the current catalog without
copying its existing panorama and mesh storage. Native panoramas use the SPHR
viewer. Matterport-linked records use their original hosted model through the
Embed SDK; restoring those links does not make their geometry self-hosted. To
remove that dependency, import the owner's E57 export through the normal pipeline.

## Export, prepare and validate

Keep the source export, inventories, SDK key file, generated packages and receipts
in the external capture store or ignored local directories. None belongs in Git.
Use a stable `--namespace`; it is part of the permanent scene identity.

```sh
psql -qAt -v ON_ERROR_STOP=1 -d SOURCE_DATABASE < scripts/legacy/export.sql > /captures/recovery/source.json
gcloud storage ls --long 'gs://SOURCE_BUCKET/spaceshare/**' > /captures/recovery/panoramas.txt
gcloud storage ls --long 'gs://SOURCE_BUCKET/meshes/**' > /captures/recovery/meshes.txt
python3 scripts/legacy/recover.py \
  --export /captures/recovery/source.json \
  --inventory /captures/recovery/panoramas.txt \
  --inventory /captures/recovery/meshes.txt \
  --namespace original-collection \
  --sdk-key-file /captures/recovery/public-embed-key \
  --out /captures/recovery/packages
python3 scripts/legacy/validate.py \
  --directory /captures/recovery/packages \
  --inventory /captures/recovery/panoramas.txt \
  --inventory /captures/recovery/meshes.txt
```

Python 3.11+, Pillow, and an authenticated Google Cloud CLI are required. The SQL
is read-only and exports selected content fields, not account records. The Embed
SDK uses a public client application key whose allowed domains must include the
viewer origin. Keep SDK secrets and backend API credentials out of bootstraps.

Preparation retains calibrated camera positions, versioned cube faces and model
transforms. Legacy node-group rotations are degrees; legacy dollhouse rotations
are radians. Explicit scene graph transforms preserve that distinction. Tour
segments resolve by their panorama references, Matterport model IDs and recorded
relationships. Ambiguous references fail instead of selecting an unrelated space.

Missing or empty source faces stop preparation and produce `audit.json`. Inspect
that record before using `--allow-unavailable-nodes`; that option omits broken
navigation targets while retaining the original export. It never substitutes a
neighboring photograph or an image from another version. A missing initial or
authored panorama remains an error. A mesh-only source opens in orbit mode.

Validation checks every panorama against the inventory, all tour references, JPEG
previews, delivered initial faces, GLB headers and external resources, audio and
video. The hash-bound `validation.json` prevents publishing modified packages.
It does not establish visual alignment; inspect real scenes and navigation too.

## Preview and publish

For local use, mount the package directory at `public/datasets/legacy`. Its index
is merged with the local E57 catalog. Canonical `/s/<id>/<slug>` links identify both
spaces and authored tours. Old `/spaces/<id>-<slug>` and `/tours/<id>-<slug>` URLs
redirect to their canonical entry, retaining query parameters and normal access
checks.

```sh
python3 scripts/legacy/publish.py --directory /captures/recovery/packages --dry-run
python3 scripts/legacy/publish.py --directory /captures/recovery/packages
```

Publish the compatible app runtime first. Publication uploads only the runtime
bootstrap and preview to immutable scene revisions, then merges the catalog with
a generation guard. Other entries, prior revisions and privacy settings survive.
The new IDs are private by default. To restore source PUBLIC records, supply
`SPHR_PUBLISH_ADMIN_USERNAME` and `SPHR_PUBLISH_ADMIN_PASSWORD` through the secret
environment and append `--make-source-public`. This affects only those recovered
IDs; it does not change access to existing scenes or their public bucket assets.

## Viewer checks

- Open native panorama, mesh-only and Matterport-linked records automatically.
- Inspect face orientation and mesh alignment; navigate by click and dollhouse entry.
- Check native → object → native and native ↔ Matterport tour transitions,
  Previous across a space boundary, and failure recovery without losing the current viewer.
- Inspect video overlays, audio/mute, caption text and object framing.
- Test the mobile header and bottom Next/Previous controls with long original text.
- Retest an existing E57 scene and the Garden splat tour.
- Verify the public catalog, old URL redirects, and existing private viewer gates.

```sh
python3 -m unittest discover -s scripts/legacy -p 'test_*.py'
node --experimental-transform-types --test scripts/test-legacy-recovery.mjs
npm run test:navigation
npm run test:hosting
npm run test:admin
npm run typecheck
npm run build
```
