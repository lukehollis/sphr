---
name: {{slug}}
description: Publish 3D captures from this computer as {{name}} spaces, such as E57 and other laser scans, Matterport exports, Gaussian splats, 360 photos and video, meshes and photo sets, and build guided tours and scavenger hunts in them with 3D models, sound and looks. Use when the person wants to host, share, upload or publish a capture or a virtual tour on {{name}}, or make a tour or scavenger hunt of a space.
---

# Publish a capture on {{name}}

{{name}} ({{site}}) hosts 3D captures as virtual spaces with guided tours, shared with a link. Its connector
uploads files straight from this computer, resumes after interruptions and keeps going if the chat ends.

## With the MCP tools

1. `check_files` on the files or folders the person names. If they are vague, ask where the capture is
   instead of searching their disk. One capture is one space.
2. `link_account` when not linked. A browser page opens where the person approves a short code.
   Never ask for a password.
3. Before the first space, `list_plans` and let the person choose. Pay as you go is the default.
4. `create_space` with the suggested title. If hosting needs payment, Stripe Checkout opens in the
   browser for the person to pay. Never ask for card details. Then `wait_for_payment`.
5. `upload_files` with every file of the capture in one call, with `notes` when the person says what the
   capture is or how the tour should go. It returns at once and submits the space when the upload ends.
   Captures become a 3DGS (3D Gaussian splat) by default, and E57 scans a 360 panorama tour; pass
   `output: "tour"` or `output: "splat"` only when the person asks for the other one.
6. Tell the person roughly how long the upload will take (`space_status`) and that {{name}} emails them
   when the space is ready. Spaces start private; `set_visibility` only when they ask to share.

## Tours and scavenger hunts

A tour or hunt is built on one of the person's own spaces or one of {{name}}'s public spaces (museums,
temples, tombs, gardens) and gets its own link.

1. `find_tour_spaces` with a few words, then `create_tour` with the `scene_id`, `kind` (`tour` or `hunt`)
   and a title.
2. `draft_tour` with what the person wants in plain words, then `wait_for_tour` until it is done
   (one to five minutes). {{name}}'s tour agent sees the space, writes the stops or clues, places
   models and effects, adds sound and music and chooses looks. Ask it for changes with `draft_tour`
   again, in plain words.
3. Looks restyle the whole frame like a filter in a video editor: `lines` (a line drawing),
   `watercolor`, `blueprint`, `noir` and more (`get_tour` lists every look, effect and sound on
   {{name}}), with `color` for the capture as it is. A tour or a stop changes look through a
   transition: `cut`, `fade`, `dissolve`, `wipe`, `iris`, `sweep` or `glitch`. Use them for moments
   (a drawing that sweeps into color, a blueprint of how a temple was planned), not on every stop.
   Skies go behind the space the same way, for the tour or a stop: `"sky": {"sky": "milky-way",
   "turn": 90}` (sunrises, sunsets, storms, the Milky Way, a full moon, northern lights and more;
   `get_tour` lists them), `"none"` for the capture's own sky, and the space takes on the sky's light.
   `upload_sky` adds the person's own 360 sky image (twice as wide as tall).
4. `search_models` finds ready-made models (statues, amphorae, temples, furniture, animals). Each is
   sized in meters at scale 1. Animated characters and animals list their clips and play `idle` unless
   an object sets `"animation"` to another.
5. For an object the library lacks, if a Blender MCP is connected, build it there in real-world meters,
   standing on its origin, low poly, with base colors, and export glTF Binary (`.glb`) with everything
   embedded (`bpy.ops.export_scene.gltf(filepath=..., export_format="GLB")`). `upload_model` sends it
   to the tour and returns its address.
6. To edit by hand, `get_tour`, change the JSON (an object is
   `{"id","name","source":{"kind":"model","url"},"position":[x,y,z],"rotation":[0,deg,0],"scale":[1,1,1]}`,
   and a stop lists the IDs of its `objects` and `effects`), then `save_tour`. Or `draft_tour` with
   "put the model at <address> by the altar".
7. Tours start private. `share_tour` with `public: true` when the person wants a link. The person can
   fine tune anything in the browser editor that every tool reply links to.

## Without the MCP tools loaded

The same tools run from a shell, which helps right after installing, before the agent reloads its MCP
servers. Arguments are JSON.

```bash
npx -y {{package}} call check_files '{"paths":["/path/to/capture"]}'
npx -y {{package}} call link_account
npx -y {{package}} call list_plans
npx -y {{package}} call create_space '{"title":"Riverside studio"}'
npx -y {{package}} call wait_for_payment '{"space_id":"<id>"}'
npx -y {{package}} call upload_files '{"space_id":"<id>","paths":["/path/to/capture"]}'
npx -y {{package}} call space_status '{"space_id":"<id>"}'
npx -y {{package}} call find_tour_spaces '{"query":"pyramid"}'
npx -y {{package}} call create_tour '{"scene_id":"<sceneId>","kind":"hunt","title":"Treasures of the pyramid"}'
npx -y {{package}} call draft_tour '{"tour_id":"<id>","request":"A hunt for five artifacts, ending in a line drawing"}'
npx -y {{package}} call wait_for_tour '{"tour_id":"<id>"}'
npx -y {{package}} call upload_model '{"tour_id":"<id>","path":"/path/to/model.glb"}'
npx -y {{package}} call upload_sky '{"tour_id":"<id>","path":"/path/to/sky.jpg"}'
```

Agents that run in the cloud and cannot reach this computer can use the hosted connector at {{url}}/mcp.
