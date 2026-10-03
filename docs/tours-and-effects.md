# Guided tours, scavenger hunts, objects and effects

A space can carry an authored experience: a **guided tour** (stops with a
camera view and text) or a **scavenger hunt** (clues, each asking visitors to
find and click a placed object). Both can place custom 3D objects in the space
and run visual effects at chosen stops or the whole time.

## Building one

Sign in at `/admin`, open a space, and choose **Make a tour or scavenger hunt**
(`/admin/scenes/<id>/tour`). Describe what you want in the text box and send it
to your agent. It looks at photographs of the space, writes every stop, places
objects where it sees fitting spots, and adds effects. Then edit anything:
retitle and rewrite stops, aim a stop at the current view, pick an object in
the space and move, turn or resize it with the gizmo, tune effects, and
preview it as a visitor. **Save** publishes it at the space's normal link.

The agent is configured on the server, first match wins:

| Variable | Agent |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude through the Messages API (`SPHR_TOUR_AGENT_MODEL`, default `claude-opus-5-5`) |
| `SPHR_TOUR_AGENT_URL` | `scripts/agent/tour-agent-service.mjs` running beside the app as its own user, wrapping an agent CLI that is logged in on the server (`CLAUDE_CODE_OAUTH_TOKEN` or a login). It runs the CLI with no tools and passes the space's images on standard input. `SPHR_TOUR_AGENT_TOKEN` must match the service's `SPHR_TOUR_AGENT_SERVICE_TOKEN`. |
| `SPHR_TOUR_AGENT_COMMAND` | Your own agent CLI as a JSON array, for example `["claude","-p","--output-format","json","--allowedTools","Read"]`. The prompt is piped to standard input unless an argument contains `{prompt}`. Images of the space are files in the working directory (`{dir}`). |

Without either, the builder still works by hand.

Placed models can come from three places: pack shapes, any `https` glTF or GLB
address, and a model library manifest named by `SPHR_LIBRARY_URL` (or
`SPHR_LIBRARY_FILE`):

```json
{ "models": [{ "id": "chest", "name": "Treasure chest", "category": "Props", "url": "props/chest.glb", "height": 0.6, "tags": ["treasure"], "scope": "everyone" }] }
```

Relative URLs resolve against the manifest. `"scope": "team"` keeps a model to
administrators, for assets licensed to your team but not to every editor.

A library of thousands of models does not fit in a prompt, so the agent sees a
sample matching the request and searches the rest. `GET /api/library/search?q=amphora&limit=24`
ranks models by name, tags, category and pack (team models only for
administrators). With the Messages API the agent calls it as a `search_models`
tool; behind `SPHR_TOUR_AGENT_URL`, set `SPHR_LIBRARY_SEARCH_URL` in the
service's environment (for example `http://127.0.0.1:3035/api/library/search`)
and it runs the CLI with `scripts/agent/library-mcp.mjs` as its only MCP server
and `mcp__library__search_models` as its only tool. Either way the agent names
models by ID, which the server turns into their addresses.

Customers' tours can also carry models of their own: the builder's *Upload a
model* button, or `POST /api/account/tours/<id>/models` with a raw glTF Binary
body. Files must be self-contained `.glb` (version 2, embedded buffers and
images, at least one mesh) of at most 25 MB, 20 per tour, and are stored under
`SPHR_STATE_DIR/tour-files/<tour>/` by content hash and served from
`/api/tour-files/<tour>/<file>.glb`. They are deleted with the tour. A model
made in Blender should be in meters, stand on its origin and be exported with
`bpy.ops.export_scene.gltf(filepath=..., export_format="GLB")`; glTF turns
Blender's Z up into Y up.

## Data

Saved experiences live in the state database (`scene_tours`) and are applied
to the space's opening segment when it is served. Packages can also author
them directly in `tour_data`:

```json
{
  "kind": "hunt",
  "finale": "You found everything.",
  "objects": [
    { "id": "coin", "name": "Old coin", "source": { "kind": "shape", "shape": "orb", "color": "#f6c642" },
      "position": [1.2, 0.4, -3], "rotation": [0, 0, 0], "scale": [1, 1, 1], "idle": "spin" }
  ],
  "effects": [
    { "id": "sweep", "type": "scan", "target": { "kind": "scene" }, "params": { "mode": "reveal", "speed": 6 } },
    { "id": "glint", "type": "sparkles", "target": { "kind": "object", "id": "coin" }, "params": { "mode": "aura" }, "always": true }
  ],
  "spaces": [{ "id": "space-id", "tourpoints": [
    { "id": "clue-1", "title": "By the door", "text": "Something shiny waits where everyone comes in.", "format": "plain",
      "nodeUUID": "scan-003", "rotation": { "azimuth": 40, "polar": -10 },
      "objects": [], "effects": ["sweep"], "find": { "objectId": "coin", "hint": "Look low.", "found": "That coin is from 1890." } }
  ] }]
}
```

A viewer can also apply an experience as a tour of its own (`{ experience, standalone: true }`
in the viewer's edits): its stops replace the space's published stops even when it has none, and
the spaces and narration a longer published tour continues into are left out. The app uses this
for customers' tours of a space, each with its own link.

Rotations of objects are degrees. Object and effect IDs are listed per stop;
`always` objects and effects also show in free exploration. Objects and effects
belong to the first space of a multi-space tour.

## Packs

Effects and shapes come in packs (`lib/experience/registry.ts`). A pack lists
plain metadata, which the builder, the validator and the agent read, and loads
its Three.js code lazily only when a space uses it. Core ships five effects
(`sparkles`, `scan`, `sketch`, `dust`, `beacon`) and four shapes (`marker`, `orb`,
`box`, `sign`). `sketch` draws the space in pencil and ink, then a radial scan
paints the color back in (or turns color into a drawing). `scan` sweeps a ring of light outward; standing at a
panorama, the photograph itself darkens and comes back behind a front that opens from the ground
at the viewer's feet (or from the target), so sky and other parts the capture mesh misses are
scanned too. Splats are restyled on
the GPU; panoramas are drawn from the photograph's own edges. A space can also
carry a companion splat trained on line drawings of its photos
(`{ "url": "...", "role": "sketch" }` in `space_data.splats`, in the manner of
[3D line drawings](https://amritkwatra.com/experiments/3d-line-drawings)); the
sketch effect then reveals between the two splats instead. Register more in `lib/experience/extra-packs.ts`.

An effect factory receives a context with the scene, camera, its target object
or point, the space's bounds and capture meshes, and, in splat spaces, a host
that adds GPU modifiers to every splat:

```ts
const create: EffectFactory = (context, instance) => ({
  update({ time, delta }) { /* animate */ },
  setActive(active) { /* fade in or out as stops change */ },
  play(cue) { /* "found", "hint" or "click" */ },
  pointer(hit) { /* surface under the pointer, for hover effects */ },
  dispose() {}
});
```

In panorama spaces the capture mesh writes depth while objects are placed, so
walls hide objects behind them, and surface effects draw over the photograph
using the mesh's geometry.

## Looks

A look restyles the whole frame, like a filter in a video editor, and a
tour or a stop can change to one through a transition: `cut`, `fade`,
`dissolve`, `wipe`, `iris` (opening from what the stop is about), `sweep`
(opening through the space like a scan) or `glitch`.

```json
"look": { "look": "blueprint", "transition": "sweep", "duration": 2 },
"stops": [{ "id": "one", "look": { "look": "lines", "transition": "iris" } }, { "id": "two", "look": "color" }]
```

The tour's look covers free exploration and every stop without its own;
`color` is the capture as it is. With no look, frames render straight to the
screen. With one, the frame renders offscreen and a full-screen shader redraws
it (`lib/three/looks`). Each look is GLSL for `vec3 look(vec2 uv)`, so adding
one is a few lines in a pack (`looks` on a Pack; see `LookMeta` in
`registry.ts`). Core ships `lines` (line drawing), `watercolor`, `blueprint`
and `noir`.

Line drawings work the way the 3D line drawings experiment by Amrit Kwatra
does (Chan, Isola and Durand's informative-drawings model, as in splatline):
every photograph of a space is redrawn by the model once, offline, with
`scripts/lines/linework.py`. Panorama faces go to
`<SPHR_LINES_BASE_URL>/<sceneId>/<style>/<uuid>/<face>.jpg` with an
`index.json`, and the viewer blends them into the photographs with the
transition's shape. For a Gaussian splat space, a companion splat trained on
the drawn photos with the same cameras is listed in `space_data.splats` with
`role: "sketch"` (or `"watercolor"`), loaded only when a look asks for it.
Without a drawn version, a look draws the frame's edges itself.

## Sound

Two effects make sound. `sound` plays a clip when a stop opens, loops it
while the stop runs, or plays it when a hunt object is found, a hint is asked
for or an object is clicked (`trigger`: `enter`, `loop`, `found`, `hint`,
`click`). Targeted at an object or a point it is positional: it pans as the
visitor looks around and fades over `range` meters. `music` is a background
track that fades in when its stop opens and out when the tour moves to a stop
without it, so one music effect listed on several stops plays straight
through them.

```json
{ "id": "score", "type": "music", "target": { "kind": "scene" }, "params": { "track": "calm", "volume": 0.35 } },
{ "id": "drip", "type": "sound", "target": { "kind": "point", "position": [2, 0.4, -1] },
  "params": { "sound": "https://example.org/drip.mp3", "trigger": "loop", "range": 6 } }
```

Sounds are named by pack ID, or given as an https URL or a site path. Packs
list sounds as renderers that return an `AudioBuffer`; core synthesizes its
set offline in the browser (`lib/experience/synth.ts`), so the repository
ships no audio files: `chime`, `sparkle`, `found`, `hint`, `pop`, `whoosh`,
`click`, the room tone `air` and the music loop `calm`. Hunt finds and hints
chime by default when a stop has no sound of its own. Everything follows the
viewer's mute button, and browsers keep it silent until the visitor's first
touch or key press.

## Agents that build tours

People's own agents build tours through the same routes as the builder with an
agent token (see `docs/accounts.md`), and both connectors wrap them as tools:
`find_tour_spaces`, `create_tour`, `draft_tour` and `wait_for_tour`,
`get_tour` (the experience, its revision, and every look, effect, sound and
shape the site has), `save_tour`, `search_models`, `upload_model` (local
connector) and `share_tour`. A draft started by an agent runs in the
background (`{ "prompt", "async": true }`, then poll `GET` for `draft.state`)
and is placed on the server the way the builder places it in the viewer: each
pixel the drafting agent picked becomes a ray from its panorama location, cast
against the space's capture mesh (`lib/server/capture-mesh.ts` reads plain and
Draco-compressed GLBs, positions only, and keeps a few in memory), and objects
follow the builder's rules in `lib/experience/placement.ts` (never at the
visitor's feet, open air puts it on the ground four meters out, far things grow
up to five times). Stops aim from where they stand toward the same spot. The
agent picks spots in photos taken from many places, so seen from the first stop
that shows it: in a guided tour, an object toward the edge of that stop's view
(more than 20 degrees left, where the tour's text covers the left on wide
screens, 32 right, or out of the frame) comes onto the ground a few meters ahead, a little
right of center (a hunt keeps its objects where they were hidden); an object more than 18 meters away comes along
the same line of sight onto the surface at 18 meters; and one the capture hides
(behind a step or a wall) comes forward onto the surface in the way, or the floor
just in front of it, which keeps every hunt object clickable from its clue. A
guided tour stop on a high vantage point, whose objects stand on ground far
below its frame, turns toward them instead, keeping them a little right of
center and tilting no more than 35 degrees down. A
space without a capture mesh uses the floor under each location as the ground.

## Checks

```bash
npm run test:experience
npm run typecheck
```
