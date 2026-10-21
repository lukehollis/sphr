---
name: sphr-matterport-link
description: Build a tour from a Matterport space the runner downloaded from its link (input/matterport-<model id>/ with link.json), with its 360 photos, positions, navigation, 50k dollhouse mesh and Mattertags, and no E57.
---

# A Matterport space from its link

The customer gave the link to a Matterport space instead of files (`source` in `job.json`). Before you started,
the runner downloaded it into `input/matterport-<model id>/`:

- `link.json`: the model ID, its name on Matterport, how many 360 photos and tags it has
- `index.html`: the showcase's model data (positions, rotations, the navigation graph, floors, asset addresses)
- the skybox faces of every 360 photo, at the best resolution Matterport offers the public
- the 50k DAM mesh and its textures, and the space's cover picture
- `api/mp/models/graph_GetMattertags.json`: the Mattertags, with the photos Matterport hosts for them

It is the space as visitors see it on Matterport. Build it as a tour; ignore `output: "splat"` and say why.

## Build

```sh
echo "Building the tour from the Matterport space's 360 photos" >> "$SPHR_JOB_DIR/output/progress.log"
node scripts/matterport/import-web.mjs --archive "$SPHR_JOB_DIR/input/matterport-<model id>" \
  --slug "$SPHR_SCENE_SLUG" --title "<title from job.json>" --public-root "$SPHR_JOB_DIR/output/public" \
  --allow-unavailable-neighbors
```

`--allow-unavailable-neighbors` is right here: Matterport leaves out 360 photos the owner hid, and the others
still name them as neighbors. Those links are dropped and recorded; nothing is invented. The import takes under
a minute for a hundred photos. It copies the faces without re-encoding, keeps every triangle and texture of the
mesh, converts poses and tags (`three = [x, z, -y]`), and validates its own package against the download.

Then check and validate as sphr-intake section 3 says. The printed summary gives the photos (`nodes`),
triangles, tags, connected areas (`graphComponents`) and `hiddenSweeps`: how many photos the owner hid on Matterport,
whose links from the others were dropped (`photosWithHiddenNeighbors` counts the photos that lost one, not hidden
photos). Open `preview.jpg` (the space's cover picture on Matterport).

## Limits and the message

- The public skyboxes are 2k at best (4k stays locked to Matterport's own viewer), and the mesh is Matterport's
  50k dollhouse with its holes. There is no measured depth or point cloud, so no E57-quality floors or splat.
- More than one connected area means visitors cannot walk between those parts; say so when more than a stray
  photo is cut off.
- Say how many Mattertags came over, when there are any.

If the folder is missing or the import fails on something the customer could fix (a combined space, no 360
photos), write `failed` with what to do instead. If the download looks incomplete, write `needs_operator`.
