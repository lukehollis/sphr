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

## Checks

```bash
npm run test:experience
npm run typecheck
```
