# Local capture storage

Keep source exports and generated capture data outside the Git checkout. Choose a
persistent capture root and record its absolute path in ignored local operator
configuration, such as `.sphr-state/deployment.env`. Never commit a workstation's
mount paths, source filenames, scan identifiers or migration receipts.

| Directory below the capture root | Contents |
| --- | --- |
| `exports/` | Original complete ZIP/E57 exports, including all parts |
| `incomplete-downloads/` | Unfinished downloads; never import these |
| `processed/` | Source manifests, calibration metadata and geometry checkpoints |
| `public/datasets/matterport/` | Generated scene packages, images, meshes and catalog |
| `migration-records/` | Source hashes, relocation receipts and visual reviews |

The importer accepts explicit paths. With `capture_root` set to your chosen archive
directory and `scratch_root` set to a sufficiently large scratch disk:

```sh
python3 .agents/scripts/matterport/inspect-export.py --downloads "$capture_root/exports"
npm run import:matterport -- \
  --e57 "$capture_root/exports/export.zip" --slug my-space --title 'My Space' \
  --public-root "$capture_root/public" \
  --processed-root "$capture_root/processed" \
  --extraction-root "$scratch_root" --discard-extracted-source
```

Alternatively, symlink the application's ignored `public/datasets/matterport`
directory to the archive's package directory. `next.config.mjs` resolves the real
capture path and chooses a common Turbopack filesystem root so linked assets can
be served locally. An absent drive leaves the link unresolved: reconnect it instead
of replacing it with an empty directory. Cloud delivery does not depend on this mount.

Before importing, check free space on both the archive and scratch disks. Budget
the largest extracted E57 part, generated images, staged and previous packages,
geometry checkpoints and operating-system headroom. Original ZIP size alone is
insufficient. `SPHR_MATTERPORT_EXTRACTION_ROOT` can also select the scratch directory.

`--discard-extracted-source` releases only derived caches after source validation.
Never discard original exports or a failed geometry checkpoint needed for a retry.
When moving data, verify every destination file's size and SHA-256 before removing
the source copy. Preserve manifests and scene IDs, and keep relocation receipts.
Do not move or import growing browser downloads as though they were complete.
