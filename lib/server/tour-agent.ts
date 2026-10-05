import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import { effectEntries, lookEntries, shapeEntries, skyEntries, soundEntries } from "@/lib/experience/packs";
import { skySunHeading } from "@/lib/experience/registry";
import { paramSummary } from "@/lib/experience/catalog";
import type { SpaceView } from "./space-views";
import { LOOK_TRANSITIONS } from "@/lib/experience/types";
import { describeModel, matchModel, searchLibrary, stem } from "@/lib/experience/library-search";
import { parseExperience } from "@/lib/experience/validate";
import type { Experience } from "@/lib/experience/types";
import type { NodeData, SphrBootstrap } from "@/lib/types";
import { nodeCubeFaceUrl, nodePanoramaUrl } from "@/lib/media";
import type { LibraryModel } from "@/lib/experience/library";
import { libraryModels } from "@/lib/server/library";

/**
 * The tour agent: a visitor-facing tour or scavenger hunt written from one
 * text box. It sees the space (panorama faces or a captured view), the
 * current draft and every installed effect, shape and library model, and
 * returns a complete new draft. Placements point at pixels in the images it
 * saw; the editor turns those into 3D positions against the capture.
 *
 * Backends, first configured wins:
 *   ANTHROPIC_API_KEY            Claude through the Messages API.
 *   SPHR_TOUR_AGENT_URL          scripts/agent/tour-agent-service.mjs, which runs an
 *                                agent CLI logged in on the server, with no tools
 *                                (SPHR_TOUR_AGENT_TOKEN authenticates).
 *   SPHR_TOUR_AGENT_COMMAND      Your own agent CLI, as a JSON array. A {prompt}
 *                                placeholder inlines the prompt, otherwise it is
 *                                piped to standard input; {dir} is the folder of
 *                                space images, e.g.
 *                                ["claude","-p","--output-format","json","--allowedTools","Read"].
 */

export const TOUR_AGENT_MODEL = process.env.SPHR_TOUR_AGENT_MODEL || "claude-opus-5-5";

export type PixelPlace = { nodeId?: string; face?: number; view?: string; x: number; y: number };
export type AgentAnchors = {
  objects: Record<string, PixelPlace>;
  stops: Record<string, PixelPlace>;
  effects: Record<string, PixelPlace>;
};
export type AgentTurn = { prompt: string; reply: string };
export type ClientView = { id: string; image: string; nodeId?: string; rotation?: { azimuth: number; polar: number }; fov?: number };
export type AgentResult = { experience: Experience; anchors: AgentAnchors; reply: string };

export class TourAgentError extends Error {}

export function tourAgentConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim()
    || process.env.SPHR_TOUR_AGENT_URL?.trim() || process.env.SPHR_TOUR_AGENT_COMMAND?.trim());
}

type AgentImage = { label: string; data: string };

const FACE_NAMES: Record<number, string> = { 1: "face 1", 2: "face 2", 3: "face 3", 4: "face 4" };

function round(value: number, places = 2) { return Number(value.toFixed(places)); }

/** Spread picks across the space so the agent sees more than one corner. */
function sampleNodes(nodes: NodeData[], preferred: string[], count: number) {
  const chosen: NodeData[] = [];
  for (const id of preferred) {
    const node = nodes.find((item) => item.uuid === id);
    if (node && !chosen.includes(node)) chosen.push(node);
    if (chosen.length >= count) return chosen;
  }
  if (!chosen.length && nodes.length) chosen.push(nodes[0]);
  while (chosen.length < Math.min(count, nodes.length)) {
    let best: NodeData | null = null;
    let bestDistance = -1;
    for (const node of nodes) {
      if (chosen.includes(node)) continue;
      const distance = Math.min(...chosen.map((item) => Math.hypot(item.position.x - node.position.x, item.position.y - node.position.y, item.position.z - node.position.z)));
      if (distance > bestDistance) { bestDistance = distance; best = node; }
    }
    if (!best) break;
    chosen.push(best);
  }
  return chosen;
}

async function loadImage(url: string, origin: string): Promise<string | null> {
  try {
    let bytes: Buffer;
    if (url.startsWith("/") && !url.startsWith("//")) {
      const local = path.join(process.cwd(), "public", decodeURIComponent(url.split("?")[0]));
      if (!local.startsWith(path.join(process.cwd(), "public"))) return null;
      try { bytes = await readFile(local); }
      catch {
        const response = await fetch(new URL(url, origin), { signal: AbortSignal.timeout(15000) });
        if (!response.ok) return null;
        bytes = Buffer.from(await response.arrayBuffer());
      }
    } else {
      if (!/^https:\/\//.test(url)) return null;
      const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "follow" });
      if (!response.ok) return null;
      bytes = Buffer.from(await response.arrayBuffer());
    }
    const jpeg = await sharp(bytes, { limitInputPixels: 80_000_000 }).rotate().resize({ width: 768, height: 768, fit: "inside" }).jpeg({ quality: 78 }).toBuffer();
    return jpeg.toString("base64");
  } catch { return null; }
}

function decodeClientImage(value: string) {
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || value.length > 2_000_000) return null;
  return match[2];
}

/** Everything the agent needs to know about the space, as text plus images. */
const STOPWORDS = new Set("the and for with that this make tour hunt space around into from each stop stops find things about some have will they them their where what when then than like want please also very more most just".split(" "));

/**
 * Libraries run to thousands of models, too many to list in every request. The agent sees
 * the models whose name, category, tags or pack match a word of the request or are already
 * placed, plus a few from every category, under short codes the server maps back to URLs.
 */
export function pickLibrary(library: LibraryModel[], prompt: string, draft: Experience, limit = 180, perCategory = 4) {
  const words = [...new Set((prompt.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((word) => !STOPWORDS.has(word)).map(stem))];
  const placed = new Set(draft.objects.flatMap((object) => object.source.kind === "model" ? [object.source.url] : []));
  // Whole words of the request (a camel is not Camelot), each counted once per model.
  const scored = library.map((model, index) => ({ model, index,
    score: placed.has(model.url) ? 100 : words.filter((word) => matchModel(model, [word]).score > 0).length }));
  const chosen = new Set(scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, limit).map((item) => item.model));
  const seen = new Map<string, number>();
  for (const model of library) {
    const count = seen.get(model.category) ?? 0;
    if (count < perCategory && !chosen.has(model)) chosen.add(model);
    seen.set(model.category, count + 1);
  }
  const listed = library.filter((model) => chosen.has(model));
  const codes = new Map(listed.map((model, index) => [`lib${index + 1}`, model.url]));
  return { listed, codes, counts: [...seen] };
}

/** Swap library codes, or model IDs found with search_models, in the agent's draft back to model URLs. */
export function resolveLibraryCodes(raw: RawDraft, codes: Map<string, string>, library: LibraryModel[] = []) {
  const byId = new Map(library.map((model) => [model.id, model.url]));
  for (const object of raw.objects ?? []) {
    const source = object.source as Record<string, unknown> | undefined;
    if (source?.kind !== "model" || typeof source.url !== "string") continue;
    const key = source.url.trim().replace(/^library:/, "");
    if (codes.has(key)) source.url = codes.get(key);
    else if (byId.has(key)) source.url = byId.get(key);
  }
  return raw;
}

/** A space's reconstruction as the agent hears of it: its title and the names of its landmarks. */
export type ReconstructionSummary = { title?: string; landmarks: string[] };

export async function buildAgentContext(bootstrap: SphrBootstrap, draft: Experience, views: ClientView[], origin: string, team = false, prompt = "", drawn: string[] = [], spaceViews: SpaceView[] = [], reconstruction: ReconstructionSummary | null = null) {
  const space = bootstrap.space;
  const data = space.space_data;
  const nodes = data.noPanos ? [] : data.nodes ?? data.navPoints ?? [];
  const images: AgentImage[] = [];
  const preferred = [...draft.stops.map((stop) => stop.view.nodeId).filter((id): id is string => Boolean(id)), ...(data.initialNode ? [data.initialNode] : [])];
  const sampled = sampleNodes(nodes, preferred, nodes.length > 1 ? 6 : 1);
  await Promise.all(sampled.map(async (node) => {
    const cube = Boolean(node.faces?.length || node.cubeFaces?.length || node.textureTemplate);
    if (cube) {
      const faces = await Promise.all([1, 2, 3, 4].map(async (face) => ({ face, data: await loadImage(nodeCubeFaceUrl(node, face, "1024", space.version), origin) })));
      for (const face of faces) if (face.data) images.push({ label: `location ${node.uuid} ${FACE_NAMES[face.face]}`, data: face.data });
    } else if (node.image) {
      const image = await loadImage(nodePanoramaUrl(node, "full"), origin);
      if (image) images.push({ label: `location ${node.uuid} panorama (equirectangular, no face)`, data: image });
    }
  }));
  for (const view of spaceViews) images.push({ label: `view ${view.id}`, data: view.image });
  for (const view of views.slice(0, 4)) {
    const image = decodeClientImage(view.image);
    if (image) images.push({ label: `view ${view.id}`, data: image });
  }
  images.sort((a, b) => a.label.localeCompare(b.label));

  const listed = nodes.length > 300 ? sampleNodes(nodes, preferred, 300) : nodes;
  const styles = drawn.filter((style) => style !== "sky");
  const outlines = drawn.includes("sky");
  const library = await libraryModels(team);
  const picked = pickLibrary(library, prompt, draft);
  const lines = [
    `Space title: ${space.title}`,
    `Kind of capture: ${nodes.length ? `${nodes.length} panorama locations${(bootstrap.tour?.tour_data?.sceneGraph ?? data.sceneGraph ?? []).some((node) => node.raycast) ? " with a 3D mesh" : ""}` : data.splats?.length ? "Gaussian splat" : "3D model"}`,
    nodes.length ? `Locations (id, label, x y z in meters, y is up${listed.length < nodes.length ? `, a spread of ${listed.length} of ${nodes.length}` : ""}):\n${listed.map((node) => `${node.uuid} ${JSON.stringify(node.label ?? "")} ${round(node.position.x)} ${round(node.position.y)} ${round(node.position.z)}`).join("\n")}` : "",
    images.length ? `Images attached, in order: ${images.map((image) => image.label).join("; ")}` : "No images of the space are attached.",
    spaceViews.length ? `This space has no panoramas, so it is shown in views drawn from its 3D ${bootstrap.space.space_data.splats?.length ? "Gaussian splat as dots of color (the real space is sharp and continuous)" : "model as a plain clay render (the real model has its own colors)"}: ${spaceViews.map((view) => `${view.id} from ${view.camera.position.map((value) => round(value)).join(" ")} heading ${round(view.camera.azimuth, 1)} tilt ${round(view.camera.polar, 1)}`).join("; ")}. Place objects, point effects and stops with {"view": view id, "x", "y"} on these images. A stop stands where its view's camera is and looks at the pixel you give, so give every stop a look in one of these views, and point at surfaces (the ground, a table, a wall), not empty background.` : "",
    views.length ? `Client views: ${views.map((view) => `${view.id} seen from ${view.nodeId ? `location ${view.nodeId}` : "a free camera"}${view.rotation ? ` heading ${round(view.rotation.azimuth, 1)} tilt ${round(view.rotation.polar, 1)}` : ""}${view.fov ? ` fov ${Math.round(view.fov)}` : ""}`).join("; ")}` : "",
    `Effects you can use:\n${effectEntries().filter((entry) => !entry.retired).map((entry) => `${entry.type} (${entry.label}): ${entry.description}${entry.requires === "splats" ? " Gaussian splat spaces only." : ""} Targets ${entry.targets.join(", ")}. Params ${entry.params.map(paramSummary).join(", ")}.`).join("\n")}`,
    `Sounds for the sound and music effects (use the ID as the sound or track param, or an https audio file address):\n${soundEntries().map((entry) => `${entry.id} (${entry.kind}): ${entry.label}. ${entry.description}`).join("\n")}`,
    styles.length
      ? `Drawn versions: a line-drawing model has redrawn this space (${styles.join(", ")}), so the ${styles.includes("watercolor") ? "line drawing, blueprint and watercolor looks show" : "line drawing and blueprint looks show"} real drawings of it and transitions reveal between drawing and photograph.`
      : "Drawn versions: none yet, so the line drawing, blueprint and watercolor looks trace the frame's edges instead, which suits strong architectural edges best.",
    `Skies for "sky" (the ID, "none" for the capture's own sky, or {"sky": "custom", "url": an https equirectangular image}). ${nodes.length
      ? outlines ? "This space's 360 photos have sky outlines, so a new sky shows wherever they see sky." : "This space's 360 photos have no sky outlines yet, so a new sky only changes their light (a night sky darkens them, a sunset warms them) and cannot show through them; say so if the person asks for a different sky."
      : "This space has no 360 photos, so a new sky shows everywhere the capture leaves empty, behind the splat or model."} Where a sky has a sun or moon, its heading is given as a stop's azimuth before turning; to put it in front of a stop that looks at azimuth A, set "turn" to A minus that heading.\n${skyEntries().map((entry) => { const sun = skySunHeading(entry); return `${entry.id} (${entry.label}, ${entry.kind}${entry.place ? `, ${entry.place}` : ""}): ${entry.description}${sun ? ` Sun or moon at heading ${sun.heading}, ${sun.height} degrees up.` : ""}`; }).join("\n")}`,
    reconstruction
      ? `Reconstruction: this space has a stylized 3D model of how the site once looked${reconstruction.title ? `, "${reconstruction.title}"` : ""}${reconstruction.landmarks.length ? `, with ${reconstruction.landmarks.slice(0, 40).join(", ")}` : ""}. In a guided tour or hunt it shows only at stops that ask for it: give a stop "reconstruction": true to show the model in place of the capture, from that stop's location in a panorama or over the whole site in an overview (a stop that explains what the place looked like). Every other stop shows the capture. One to three stops is plenty.`
      : "",
    `Looks for "style" (the ID as look, "color" for the capture as it is; transitions ${LOOK_TRANSITIONS.join(", ")}):\n${lookEntries().map((entry) => `${entry.id} (${entry.label}): ${entry.description}${entry.requires === "splats" ? " Gaussian splat spaces only." : ""}${entry.params.length ? ` Params ${entry.params.map(paramSummary).join(", ")}.` : ""}`).join("\n")}`,
    `Shapes you can place (source {"kind":"shape","shape":...,"color":"#rrggbb","text":...}):\n${shapeEntries().map((entry) => `${entry.shape}: ${entry.description} About ${entry.size} m tall at scale 1, default color ${entry.color}.${entry.text ? " Shows its text." : ""}`).join("\n")}`,
    library.length ? `Library models you can place (source {"kind":"model","url":"<code>"} with the code before each model, or a model ID from search_models when you have that tool). The library holds ${library.length} models (${picked.counts.map(([category, count]) => `${category} ${count}`).join(", ")}); listed are those matching the request and a few of each category, and search_models finds the rest:\n${picked.listed.map((model, index) => `lib${index + 1} ${model.name}, ${model.category}, about ${round(model.height)} m tall at scale 1${model.tags?.length ? `, ${model.tags.join(" ")}` : ""}${model.animations?.length ? `, animated: ${model.animations.join(", ")}` : ""}`).join("\n")}` : "",
    `Current draft:\n${JSON.stringify(draft)}`
  ].filter(Boolean);
  return { text: lines.join("\n\n"), images, library, codes: picked.codes };
}

export const SYSTEM = `You build guided tours and scavenger hunts inside captured 3D spaces for Spacery's viewer.
A tour is a sequence of stops. Each stop stands at a panorama location (or a free camera in splat spaces), looks somewhere, and shows a short title and text. A scavenger hunt is a sequence of clues; each step hides one placed object that the visitor must find and click, then shows a found message.

You always answer by calling the write_tour tool exactly once with the complete new draft. Keep everything from the current draft that the request does not change, including IDs, text the person wrote and object positions they set.

Placing things. You see photographs of the space. To aim a stop's camera or to place an object or effect, give a pixel in one of those images as fractions from its top left: {"nodeId": location, "face": face number from the image label (omit for an equirectangular panorama), "x": 0..1, "y": 0..1}, or {"view": view id, "x", "y"} for a view (one the person sent, or one drawn of a space without panoramas). Point at the exact spot where the thing should sit, for example the top of a table or the base of a statue. Only point at things you can actually see. Place objects a few meters out in the scene where a visitor will see them, never on the floor right below the camera, which is where the visitor stands. Keep each object within about 3 to 15 meters of the location of the stop that shows it and inside that stop's view: much farther away a life-size thing is too small to notice, so in a large space point at a spot near the stop rather than across it. In a guided tour, place a stop's objects by pointing into the same image you aimed that stop with, near what it looks at, so they are in its view. In a scavenger hunt, make the visitor look around and walk a little: aim each clue's stop at the area or landmark the clue talks about, not at the object, and hide the object where it is not in that opening view, off to the side or behind the visitor, up on a ledge or down in a niche, or behind a column, wall or corner where it shows from a location one to three steps away (point at it in the photograph from that location). Only the first clue may sit near the edge of the opening view. Keep an existing object's position by leaving its position as it is and place null.

Writing. Text is plain, warm and specific to what is visible. Two to four sentences per stop. No markdown, no lists, no emoji. Titles are two to five words. Hunt clues name the area and a landmark to head for without naming the exact spot; hints say plainly where to turn or walk and where to look; found messages reward the visitor with one real detail about the place.

Sound. A little sound goes a long way: background music or an ambient bed fitting the place (a music effect, always or on chosen stops), and a few sound effects tied to moments. Hunt finds and hints already chime.

Models. Prefer a library model to a plain shape whenever one fits: an amphora, a statue, a lantern, a chest, a column. The models listed below are only a sample of the library. When you have the search_models tool (it may be named mcp__library__search_models), search the whole library for each kind of thing you want to place before you choose (several short searches beat one long one, for example "amphora", "bronze statue", "brazier") and use a result's ID as the model's url. When the person gives the address of a model of their own (an https .glb, such as one they made in Blender and uploaded to the tour), use that address as the url. Models are sized in meters at scale 1, so a 0.9 m amphora at scale 1 is life size; scale only to make a point (a giant key, a tiny temple model). Characters and animals listed as animated play their idle clip; set "animation" to one of their listed clip names for another (a walk, a dance), and give animated models idle "none". In a photographic capture prefer realistic models; toy, blocky or cartoon packs (Kenney, Toon, POLYGON Kids and the like) only when the person wants a playful look, and keep to one style within a tour.

Looks. A look restyles the whole frame, like a filter in a video editor: a line drawing, a blueprint, film noir, night vision and more. Set "style" on the tour for its overall look, or on a stop to change the look there, with a transition: cut, fade, dissolve, wipe, iris (opens from what the stop is about), sweep (opens through the space like a scan) or glitch, and a duration in seconds. A stop without "style" keeps the tour's look; give a stop {"look": "color"} to return to the capture itself. Use looks to mark moments and moods (a line drawing that sweeps into color, a blueprint for how a building was planned, noir for a mystery, a flashlight for a dark tomb or cave), not on every stop.

Skies. Set "sky" on the tour, or on a stop to change the sky there, to put another sky behind the space: {"sky": ID, "turn": degrees to turn it around the vertical (to put its sun or moon behind what a stop looks at), "brightness": 0.2 to 2.5, "light": 0 to 1 for how much the space takes on the sky's light, "duration": seconds to fade}. The space takes on the sky's light, so a night sky turns a sunny capture into night and a sunset warms it; "light" 0 keeps the capture's own light. Match the sky to the story (stars over a temple at night, a storm for a battle, a sunrise for a beginning) and to the place when it matters; a stop without "sky" keeps the tour's sky, and {"sky": "none"} returns to the capture's own. Change the sky at a few moments, not every stop.

The map. A stop can fly up out of the capture to a view from above over Google's photorealistic 3D map, then the next stop dives back down into its panorama or splat. Give such a stop "earth": {"range": meters from the ground to the camera} (300 to 800 for a single building or courtyard, 1000 to 3000 for a whole valley or city) and a "rotation" whose tilt (polar) looks down between -30 and -70, aimed with azimuth like any stop; its nodeId is the location the view centers on. Use it to open a tour by showing where the site sits in its landscape, to move between distant parts of a site, or to close by pulling back. One or two per tour is plenty. It only shows once the space is on the map: if the draft has no "place" and you know where this site is, give "place": {"lat", "lon"} in decimal degrees for the location the tour starts at, and a person will turn the map to line it up.

Effects. Use effects to serve the story, not everywhere. A stop lists the effect IDs that run while it is shown; "always" effects run through free exploration too. Use the object target to attach an effect to a placed object. An effect with a trigger param runs with its stop by default and also answers a find, a hint or a click on its object; "trigger": "found", "hint" or "click" holds it back until that moment alone, so it shows nothing before then even on its stop's list. Hunt finds already burst with sparkles and the hint button already lights up the object, so a celebration of your own is optional: aim it at the hunt object with "trigger": "found" (confetti, ground ripples, a patch of blooming flowers, a scan sweeping out from it) and it plays in place of the sparkles the moment the object is found; one at a spot or over the whole space plays for the find of a stop that lists it. Never give a hunt object an effect that runs before it is found (sparkles, glitter, lights or a beacon on it or at its spot would give it away), and never leave a celebration on it at the default trigger, which also fires when a hint is asked for. Use colors that suit the space.

Sizes. Real objects should be life size. Hunt items are usually 0.15 to 0.5 m.

Reply in one or two plain sentences saying what you made or changed.`;

const placeSchema = {
  anyOf: [
    { type: "null" },
    {
      type: "object",
      properties: {
        nodeId: { type: "string" }, face: { type: "integer", minimum: 0, maximum: 5 }, view: { type: "string" },
        x: { type: "number", minimum: 0, maximum: 1 }, y: { type: "number", minimum: 0, maximum: 1 }
      },
      required: ["x", "y"]
    }
  ]
} as const;

const vec3Schema = { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 } as const;

/** A sky behind the space, for the tour or a stop. */
const skySchema = {
  type: "object",
  properties: { sky: { type: "string" }, url: { type: "string" }, turn: { type: "number" }, brightness: { type: "number" }, light: { type: "number" }, duration: { type: "number" } },
  required: ["sky"]
};

/** A look for the frame: the agent's name for a stop's or the tour's StopLook. */
const styleSchema = {
  type: "object",
  properties: { look: { type: "string" }, transition: { type: "string", enum: [...LOOK_TRANSITIONS] }, duration: { type: "number" }, params: { type: "object" } },
  required: ["look"]
};

const WRITE_TOUR: Anthropic.Tool = {
  name: "write_tour",
  description: "Save the complete new draft of the tour or scavenger hunt, plus a short reply to the person.",
  input_schema: {
    type: "object",
    properties: {
      reply: { type: "string" },
      kind: { type: "string", enum: ["tour", "hunt"] },
      finale: { type: "string" },
      style: styleSchema,
      sky: skySchema,
      place: { type: "object", properties: { lat: { type: "number" }, lon: { type: "number" } }, required: ["lat", "lon"] },
      objects: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" }, name: { type: "string" },
            source: { type: "object", properties: { kind: { type: "string", enum: ["shape", "model", "image"] }, shape: { type: "string" }, url: { type: "string" }, color: { type: "string" }, text: { type: "string" } }, required: ["kind"] },
            place: placeSchema,
            position: { anyOf: [{ type: "null" }, vec3Schema] },
            rotation: vec3Schema,
            scale: { anyOf: [{ type: "number" }, vec3Schema] },
            idle: { type: "string", enum: ["none", "spin", "bob", "float"] },
            animation: { type: "string" },
            label: { type: "string" },
            always: { type: "boolean" }
          },
          required: ["id", "name", "source"]
        }
      },
      effects: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" }, type: { type: "string" }, name: { type: "string" },
            target: { type: "object", properties: { kind: { type: "string", enum: ["scene", "object", "point"] }, id: { type: "string" }, place: placeSchema, position: vec3Schema }, required: ["kind"] },
            params: { type: "object" },
            always: { type: "boolean" }
          },
          required: ["id", "type", "target"]
        }
      },
      stops: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" }, title: { type: "string" }, text: { type: "string" }, detail: { type: "string" },
            nodeId: { type: "string" },
            look: placeSchema,
            rotation: { type: "object", properties: { azimuth: { type: "number" }, polar: { type: "number" } } },
            position: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } },
            fov: { type: "number" },
            earth: { anyOf: [{ type: "null" }, { type: "object", properties: { range: { type: "number" } }, required: ["range"] }] },
            reconstruction: { anyOf: [{ type: "null" }, { type: "boolean" }] },
            style: styleSchema,
            sky: skySchema,
            objects: { type: "array", items: { type: "string" } },
            effects: { type: "array", items: { type: "string" } },
            find: { type: "object", properties: { objectId: { type: "string" }, hint: { type: "string" }, found: { type: "string" } }, required: ["objectId"] }
          },
          required: ["id", "title", "text"]
        }
      }
    },
    required: ["reply", "kind", "objects", "effects", "stops"]
  }
};

export type RawDraft = {
  reply?: unknown; kind?: unknown; finale?: unknown; style?: unknown; sky?: unknown; place?: unknown;
  objects?: Array<Record<string, unknown>>; effects?: Array<Record<string, unknown>>; stops?: Array<Record<string, unknown>>;
};

function asPlace(value: unknown): PixelPlace | null {
  const place = value as Record<string, unknown> | null;
  if (!place || typeof place !== "object" || typeof place.x !== "number" || typeof place.y !== "number") return null;
  const clamp = (number: number) => Math.min(1, Math.max(0, number));
  return {
    x: clamp(place.x), y: clamp(place.y),
    ...(typeof place.nodeId === "string" ? { nodeId: place.nodeId } : {}),
    ...(typeof place.face === "number" ? { face: Math.round(place.face) } : {}),
    ...(typeof place.view === "string" ? { view: place.view } : {})
  };
}

/** Split the agent's pixel placements from the draft and validate the rest. */
export function normalizeAgentDraft(raw: RawDraft, previous: Experience, nodeIds: Set<string>): AgentResult {
  const anchors: AgentAnchors = { objects: {}, stops: {}, effects: {} };
  const previousObjects = new Map(previous.objects.map((object) => [object.id, object]));
  const previousStops = new Map(previous.stops.map((stop) => [stop.id, stop]));
  const objects = (raw.objects ?? []).map((object) => {
    const id = String(object.id ?? "");
    const place = asPlace(object.place);
    if (place) anchors.objects[id] = place;
    const position = Array.isArray(object.position) ? object.position : previousObjects.get(id)?.position ?? [0, 0, 0];
    const { place: _place, ...rest } = object;
    return { ...rest, position, rotation: object.rotation ?? previousObjects.get(id)?.rotation ?? [0, 0, 0], scale: object.scale ?? previousObjects.get(id)?.scale ?? 1 };
  });
  const effects = (raw.effects ?? []).map((effect) => {
    const target = (effect.target ?? { kind: "scene" }) as Record<string, unknown>;
    const place = target.kind === "point" ? asPlace(target.place) : null;
    if (place) anchors.effects[String(effect.id ?? "")] = place;
    const position = Array.isArray(target.position) ? target.position : [0, 0, 0];
    return { ...effect, target: target.kind === "point" ? { kind: "point", position } : target };
  });
  const firstNode = nodeIds.values().next().value as string | undefined;
  const stops = (raw.stops ?? []).map((stop) => {
    const id = String(stop.id ?? "");
    const before = previousStops.get(id);
    const look = asPlace(stop.look);
    const nodeId = typeof stop.nodeId === "string" && nodeIds.has(stop.nodeId) ? stop.nodeId : look?.nodeId && nodeIds.has(look.nodeId) ? look.nodeId : before?.view.nodeId ?? firstNode;
    if (look) anchors.stops[id] = { ...look, nodeId: look.nodeId ?? nodeId };
    const rotation = stop.rotation && typeof stop.rotation === "object" ? stop.rotation : before?.view.rotation ?? { azimuth: 0, polar: 0 };
    return {
      id, title: stop.title, text: stop.text, detail: stop.detail,
      view: { nodeId, rotation, ...(stop.position ? { position: stop.position } : before?.view.position ? { position: before.view.position } : {}), ...(typeof stop.fov === "number" ? { fov: stop.fov } : before?.view.fov ? { fov: before.view.fov } : {}),
        ...(stop.earth === undefined ? before?.view.earth ? { earth: before.view.earth } : {} : stop.earth ? { earth: stop.earth } : {}),
        ...(stop.reconstruction === undefined ? typeof before?.view.reconstruction === "boolean" ? { reconstruction: before.view.reconstruction } : {}
          : typeof stop.reconstruction === "boolean" ? { reconstruction: stop.reconstruction } : {}),
        ...(before?.view.distance !== undefined ? { distance: before.view.distance } : {}),
        ...(before?.view.reconstructionVariant ? { reconstructionVariant: before.view.reconstructionVariant } : {}) },
      objects: stop.objects ?? [], effects: stop.effects ?? [], find: stop.find,
      look: stop.style === undefined ? before?.look : stop.style,
      sky: stop.sky === undefined ? before?.sky : stop.sky,
      files: before?.files, sounds: before?.sounds, models: before?.models, annotations: before?.annotations
    };
  });
  const look = raw.style === undefined ? previous.look : raw.style;
  const sky = raw.sky === undefined ? previous.sky : raw.sky;
  // A place a person lined up stays; the agent only suggests where an unplaced space is.
  const suggested = raw.place as { lat?: unknown; lon?: unknown } | undefined;
  const place = previous.place ?? (suggested && typeof suggested === "object" ? { lat: suggested.lat, lon: suggested.lon, heading: 0 } : undefined);
  const experience = parseExperience({ version: 1, kind: raw.kind, finale: raw.finale, look, sky, place, objects, effects, stops }, { nodeIds: nodeIds.size ? nodeIds : undefined, lenient: true });
  const dropped = objects.length - experience.objects.length;
  const said = typeof raw.reply === "string" && raw.reply.trim() ? raw.reply.trim().slice(0, 600) : "Here is a new draft.";
  const reply = dropped > 0 ? `${said} (${dropped === 1 ? "One object" : `${dropped} objects`} could not be placed because the model was not found in the library.)` : said;
  return { experience, anchors, reply };
}

function userContent(context: { text: string; images: AgentImage[] }, history: AgentTurn[], prompt: string): Anthropic.ContentBlockParam[] {
  const content: Anthropic.ContentBlockParam[] = [];
  for (const image of context.images) {
    content.push({ type: "text", text: image.label });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image.data } });
  }
  const earlier = history.slice(-6).map((turn) => `They asked: ${turn.prompt}\nYou replied: ${turn.reply}`).join("\n\n");
  content.push({ type: "text", text: `${context.text}${earlier ? `\n\nEarlier in this conversation:\n${earlier}` : ""}\n\nThe person asks:\n${prompt}` });
  return content;
}

const SEARCH_MODELS = {
  name: "search_models",
  description: "Search the whole model library by what you need (for example \"bronze statue\", \"canopic jar\", \"wooden chest\"). Returns model IDs to use as a model's url, with names, kinds and heights.",
  input_schema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] }
};

async function viaApi(context: { text: string; images: AgentImage[]; library?: LibraryModel[] }, history: AgentTurn[], prompt: string, check: (raw: RawDraft) => void): Promise<RawDraft> {
  const client = new Anthropic({ maxRetries: 2, timeout: 240_000 });
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: userContent(context, history, prompt) as Anthropic.Beta.BetaContentBlockParam[] }];
  const library = context.library ?? [];
  let searches = 0;
  for (let attempt = 0; attempt < 3 + searches; attempt += 1) {
    const stream = client.beta.messages.stream({
      model: TOUR_AGENT_MODEL,
      max_tokens: 32000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: SYSTEM,
      tools: [WRITE_TOUR as Anthropic.Beta.BetaTool, ...(library.length ? [SEARCH_MODELS as Anthropic.Beta.BetaTool] : [])],
      tool_choice: { type: "auto" },
      messages
    });
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") throw new TourAgentError("The agent declined this request. Try describing the tour differently.");
    if (message.stop_reason === "max_tokens") throw new TourAgentError("The draft ran too long. Ask for fewer stops or less text.");
    const call = message.content.find((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use" && block.name === "write_tour");
    messages.push({ role: "assistant", content: message.content as Anthropic.Beta.BetaContentBlockParam[] });
    const lookups = message.content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use" && block.name === "search_models");
    if (!call && lookups.length && searches < 12) {
      searches += 1;
      messages.push({ role: "user", content: lookups.map((lookup) => {
        const input = lookup.input as { query?: unknown; limit?: unknown };
        const found = searchLibrary(library, String(input.query ?? ""), typeof input.limit === "number" ? input.limit : 16);
        return { type: "tool_result" as const, tool_use_id: lookup.id, content: found.length ? found.map(describeModel).join("\n") : "No models match. Try other words, or use a shape." };
      }) });
      continue;
    }
    if (!call) {
      messages.push({ role: "user", content: "Call write_tour with the complete draft." });
      continue;
    }
    try {
      const raw = call.input as RawDraft;
      check(raw);
      return raw;
    } catch (error) {
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: call.id, is_error: true, content: `The draft was not saved. ${error instanceof Error ? error.message : "It was invalid."} Fix it and call write_tour again.` }] });
    }
  }
  throw new TourAgentError("The agent could not produce a valid draft. Try again.");
}

async function viaCommand(context: { text: string; images: AgentImage[] }, history: AgentTurn[], prompt: string): Promise<RawDraft> {
  let template: unknown;
  try { template = JSON.parse(process.env.SPHR_TOUR_AGENT_COMMAND ?? ""); } catch { template = null; }
  if (!Array.isArray(template) || !template.length || !template.every((part) => typeof part === "string")) {
    throw new TourAgentError("SPHR_TOUR_AGENT_COMMAND must be a JSON array of strings.");
  }
  const directory = await mkdtemp(path.join(tmpdir(), "sphr-tour-agent-"));
  try {
    const names = await Promise.all(context.images.map(async (image, index) => {
      const name = `${String(index + 1).padStart(2, "0")}-${image.label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.jpg`;
      await writeFile(path.join(directory, name), Buffer.from(image.data, "base64"));
      return `${name} is ${image.label}`;
    }));
    const schema = JSON.stringify(WRITE_TOUR.input_schema);
    const fullPrompt = `${SYSTEM}\n\nInstead of calling a tool, answer with only one JSON object matching this schema, and nothing else:\n${schema}\n\n${names.length ? `Images of the space are files in ${directory}. Look at each one: ${names.join("; ")}.\n\n` : ""}${userContent({ text: context.text, images: [] }, history, prompt).map((block) => block.type === "text" ? block.text : "").join("\n")}`;
    // Without a {prompt} placeholder the prompt goes to the agent's standard input.
    const inline = (template as string[]).some((part) => part.includes("{prompt}"));
    const args = (template as string[]).map((part) => part.replaceAll("{prompt}", fullPrompt).replaceAll("{dir}", directory));
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(args[0], args.slice(1), { cwd: directory, stdio: [inline ? "ignore" : "pipe", "pipe", "pipe"], env: process.env });
      if (!inline) child.stdin?.end(fullPrompt);
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new TourAgentError("The agent took too long.")); }, 300_000);
      child.stdout?.on("data", (chunk) => { stdout += chunk; if (stdout.length > 4_000_000) child.kill("SIGTERM"); });
      child.stderr?.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => { clearTimeout(timer); reject(new TourAgentError(`Unable to start the agent. ${error.message}`)); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new TourAgentError(`The agent stopped with an error. ${stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`));
      });
    });
    return extractJson(output);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** The agent service: images travel as content blocks, the CLI has no tools. */
async function viaService(context: { text: string; images: AgentImage[] }, history: AgentTurn[], prompt: string): Promise<RawDraft> {
  const url = process.env.SPHR_TOUR_AGENT_URL!.trim().replace(/\/$/, "");
  const schema = JSON.stringify(WRITE_TOUR.input_schema);
  const text = `Instead of calling a tool, answer with only one JSON object matching this schema, and nothing else:\n${schema}\n\n`
    + userContent({ text: context.text, images: [] }, history, prompt).map((block) => block.type === "text" ? block.text : "").join("\n");
  let response: Response;
  try {
    response = await fetch(`${url}/compose`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.SPHR_TOUR_AGENT_TOKEN ?? ""}` },
      body: JSON.stringify({ system: SYSTEM, prompt: text, images: context.images }),
      // Long enough to wait behind other drafts in the service's queue, then draft.
      signal: AbortSignal.timeout(900_000)
    });
  } catch (failure) {
    throw new TourAgentError((failure as Error).name === "TimeoutError"
      ? "The tour agent took too long, usually because several drafts were waiting. Try again in a few minutes."
      : "The tour agent is not reachable right now. Try again in a minute.");
  }
  const result = await response.json().catch(() => ({})) as { output?: string; error?: string };
  if (!response.ok || typeof result.output !== "string") throw new TourAgentError(result.error || "The agent could not finish. Try again.");
  return extractJson(result.output);
}

/** Pull the draft out of CLI output, which may wrap it in a JSON envelope or prose. */
export function extractJson(output: string): RawDraft {
  const candidates: string[] = [output.trim()];
  let envelope: { result?: unknown; is_error?: unknown; stops?: unknown } | null = null;
  try { envelope = JSON.parse(output.trim()); } catch { /* not an envelope */ }
  if (envelope?.is_error === true) throw new TourAgentError(`The agent reported a problem. ${String(envelope.result ?? "").slice(0, 300)}`);
  try {
    if (envelope && typeof envelope.result === "string") candidates.unshift(envelope.result);
    else if (envelope && typeof envelope === "object" && Array.isArray(envelope.stops)) return envelope as RawDraft;
  } catch { /* not an envelope */ }
  for (const candidate of candidates) {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(candidate)?.[1];
    for (const text of [fenced, candidate].filter(Boolean) as string[]) {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start < 0 || end <= start) continue;
      try {
        const value = JSON.parse(text.slice(start, end + 1));
        if (value && typeof value === "object") return value as RawDraft;
      } catch { /* keep looking */ }
    }
  }
  throw new TourAgentError("The agent did not return a draft.");
}

export async function composeTour(options: {
  bootstrap: SphrBootstrap; draft: Experience; prompt: string; history: AgentTurn[]; views: ClientView[]; origin: string; kind: "tour" | "hunt"; team?: boolean;
  /** Drawn versions of the space (from its variants manifest or companion splats), such as contour and watercolor. */
  drawn?: string[];
  /** Views drawn on the server of a space without panoramas (see space-views.ts). */
  spaceViews?: SpaceView[];
  /** The space's reconstruction, when it has one (see reconstructions.ts). */
  reconstruction?: ReconstructionSummary | null;
}): Promise<AgentResult & { library: LibraryModel[] }> {
  if (!tourAgentConfigured()) throw new TourAgentError("No agent is set up on this server. Set ANTHROPIC_API_KEY, SPHR_TOUR_AGENT_URL or SPHR_TOUR_AGENT_COMMAND.");
  const data = options.bootstrap.space.space_data;
  const nodeIds = new Set(data.noPanos ? [] : (data.nodes ?? data.navPoints ?? []).map((node) => node.uuid));
  const context = await buildAgentContext(options.bootstrap, options.draft, options.views, options.origin, options.team, options.prompt, options.drawn, options.spaceViews, options.reconstruction);
  const prompt = `${options.prompt}\n\n(Make this a ${options.kind === "hunt" ? "scavenger hunt" : "guided tour"} unless the request says otherwise.)`;
  const check = (raw: RawDraft) => { normalizeAgentDraft(resolveLibraryCodes(raw, context.codes, context.library), options.draft, nodeIds); };
  const raw = process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim()
    ? await viaApi(context, options.history, prompt, check)
    : process.env.SPHR_TOUR_AGENT_URL?.trim()
      ? await viaService(context, options.history, prompt)
      : await viaCommand(context, options.history, prompt);
  return { ...normalizeAgentDraft(resolveLibraryCodes(raw, context.codes, context.library), options.draft, nodeIds), library: context.library };
}
