# Scene collection and permanent links

The homepage `/` is the searchable collection. `/library` redirects there. Each imported
package gets a persistent 12-character `sceneId` and a readable slug derived from its title:

```text
/s/9bbdea70264e/harvard-computational-robotics-group-lab
```

The ID selects the scene. `/s/9bbdea70264e` and URLs containing an older title slug redirect
to the current canonical URL. Titles, thumbnails and descriptions populate sharing metadata.
Unknown IDs return a real 404 with a link back to the collection. Existing `/?config=…`
and `/?demo=garden` links continue to work.

## Managing 50–100 captures

Import each capture with the normal pipeline. Each completed import updates the catalog:

```sh
npm run import:matterport -- --e57 /captures/export.zip --slug my-space --title 'My Space'
```

The collection reads lightweight listing metadata, and lazy-loads photographs. It does not
initialize the 3D renderer or download scene meshes/panorama sets until a scene is opened.
Search matches titles and IDs; sorting supports recent imports, title and location count.
Copy-link controls are available on each card and the viewer toolbar. Individual
spaces load directly into free exploration or their authored tour without an intro screen.
If clipboard access is unavailable, a selectable URL is shown instead.

Use a unique storage `--slug` per scene. Reimporting that same storage slug preserves its
saved ID even when source bytes or the display title change. Preserve `sceneId` when moving
a package to a different folder. Two packages with the same ID are rejected by reindexing.
The readable URL title is separate from the storage folder; no asset paths need to change
when a title changes.

For packages created before permanent IDs, run the one-time backfill/reindex:

```sh
npm run scenes:index
```

This standard-library Python command writes IDs into package manifests and atomically
replaces `public/datasets/matterport/index.json`. It does not rebuild photographs or meshes.
Repeated indexing preserves IDs. Keep manifests in backups; deleting identity fields and
generating replacement IDs would break existing links. Hidden staging/backup directories
and incomplete packages without a bootstrap are excluded.

The server rereads the index on each request. New scene routes need no application rebuild.
Restart `next start` after copying/importing new asset directories so Next also recognizes
their new public files. Updates to existing scene metadata are visible on the next request.

## Public hosting

For the current Mused deployment (Vercel app plus GCP static assets), use
[Mused hosting](mused-hosting.md). The app supports a remote catalog and the
`npm run scenes:publish` command uploads validated packages without a Vercel redeploy.

Local links work on the computer running SPHR. Internet sharing requires deploying the
Next application and its generated assets to the chosen public host. No public deployment
is implied by a local import or by copying a localhost link.

For a persistent Node host:

1. Install the app with `npm ci` and build with `npm run build`.
2. Copy the complete `public/datasets/matterport/` tree, including the index, manifests,
   bootstraps, previews, faces and meshes. These generated assets are ignored by Git and
   will not arrive through a code-only deployment. Include demo assets if retaining the
   Garden demo link.
3. Set `SPHR_PUBLIC_URL=https://your-domain.example` for build/start so canonical and social
   preview metadata use the public domain.
4. Run `npm run start` behind the host's HTTPS endpoint. Keep `public/datasets` on persistent
   storage across application releases. Raw E57/ZIP exports stay outside `public`.
5. Check a scene URL, its preview, a real navigation and a reload from another device.

Copy-link controls use the current site's origin automatically. Moving from localhost to
the public domain does not require rewriting scene IDs, slugs or asset URLs. Back up both
the original exports and the generated packages, including their persistent IDs.

## Verification

```sh
npm run test:catalog
node scripts/test-scene-routes.mjs http://localhost:3002
npm run typecheck
npm run build
```

Catalog tests cover 100 entries, repeated indexing, duplicate IDs, URL-safe titles and
identity preservation across title/source changes. Route integration checks exercise every
real local scene, ID-only and old-title redirects, preview/config access, metadata, unknown
IDs and legacy links. Browser acceptance also requires actual thumbnails, title/ID search,
sorting, an empty result, clipboard contents, a working scene and mobile layout.
