# Local capture storage

The capture archive for this workstation is `/Volumes/amaryl/spaces`.
Mount `amaryl` before importing, validating, publishing, or serving local captures.
The deployed app and GCS assets operate independently of this drive.

| Directory | Contents |
| --- | --- |
| `exports/` | Original Matterport ZIP exports, including every E57 part |
| `incomplete-downloads/` | Preserved unfinished downloads; do not import these |
| `processed/` | Private source manifests, scan metadata and geometry checkpoints |
| `public/datasets/matterport/` | Generated scene packages, panoramas, GLBs, catalog and validation receipts |
| `migration-records/` | SHA-256 receipts for the storage relocation |

The former `~/Downloads/mp_e57_*.zip` paths are compatibility symlinks to `exports/`.
The workspace's `data/processed` and application's `public/datasets/matterport`
directories also link to the external drive. New final packages and catalog updates
therefore use the drive without changing web URLs or scene IDs. These local links
and generated assets are excluded from Git.

The build configuration resolves the capture directory's real path and selects the
common filesystem ancestor of it and the app as Turbopack's root. Ordinary checkouts
keep their project root; an external mounted drive on this Mac requires `/`. This
lets standard build/dev commands resolve the catalog symlink. Hosted deployment uses
the remote catalog and does not depend on this mount. Next.js documents Turbopack's
[filesystem root restrictions](https://nextjs.org/docs/app/api-reference/turbopack#filesystem-root).

Use the external path for subsequent completed exports:

```sh
python3 .agents/scripts/matterport/inspect-export.py --downloads /Volumes/amaryl/spaces/exports
npm run import:matterport -- \
  --e57 /Volumes/amaryl/spaces/exports/mp_e57_Title_ModelID.zip \
  --slug my-space --title 'My Space' --discard-extracted-source
```

Before a large import, check both drives with `df -h . /Volumes/amaryl`. Original
ZIPs, final packages and conversion scratch space can together exceed the external
drive's free capacity. A temporary local `--processed-root` is appropriate when the
Mac has sufficient room for the largest raw part, fusion checkpoint and headroom.
Keep the final public root on the external drive. Once the source-verified import
finishes, move its private metadata to external `processed/` and remove only its
empty temporary extraction directory. Never discard the original ZIP or a failed
geometry checkpoint needed for a retry.

The running September 16 Copán import temporarily retains its extracted source in
the workspace scratch directory. Its external `processed/.../source` link points to
that scratch directory while it runs. `--discard-extracted-source` removes each raw
cache only after its source checks pass; the link is removed when the import finishes.

The relocation verifies every copied file's byte count and SHA-256 before removing
its internal-disk copy. Each original source path stays usable through a symlink.
An absent drive leaves these links unresolved: reconnect it rather than replacing
the links with empty local directories. Unfinished browser downloads remain
unfinished after relocation; moving them does not resume or complete the download.
