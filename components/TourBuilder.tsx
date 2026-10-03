"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Camera, Eye, Move3d, Plus, Rotate3d, Scale3d, Send, Sparkles, Trash2, X } from "lucide-react";
import SphrApp from "./SphrApp";
import type { SceneListing } from "@/lib/scene-types";
import type { SceneEdits } from "@/lib/scene-edits";
import type { ObjectTransform, RuntimeState } from "@/lib/types";
import type { ViewerSession } from "@/lib/viewer/ViewerSession";
import type { GizmoMode, ViewCamera } from "@/lib/three/SphrRuntime";
import { stopToTourPoint } from "@/lib/experience/apply";
import { effectEntries, effectEntry, shapeEntries, shapeEntry } from "@/lib/experience/packs";
import { resolveParams, type ParamSpec } from "@/lib/experience/registry";
import { newId, type EffectInstance, type Experience, type ExperienceKind, type ExperienceStop, type PlacedObject, type Vec3 } from "@/lib/experience/types";
import { parseExperience } from "@/lib/experience/validate";
import type { LibraryModel } from "@/lib/experience/library";

type Props = {
  scene: SceneListing;
  edits: Pick<SceneEdits, "title" | "startView">;
  initial: Experience;
  saved: { experience: Experience | null; revision: number };
  library: LibraryModel[];
  agentReady: boolean;
  back: { href: string; label: string };
  api: string;
};

type Turn = { prompt: string; reply: string };
type Anchor = { nodeId?: string; face?: number; view?: string; x: number; y: number };
type Tab = "stops" | "objects" | "effects";

function updateFor(draft: Experience) {
  return { kind: draft.kind, objects: draft.objects, effects: draft.effects, points: draft.stops.map(stopToTourPoint), finale: draft.finale };
}

export default function TourBuilder({ scene, edits, initial, saved: initialSaved, library, agentReady, back, api }: Props) {
  const session = useRef<ViewerSession | null>(null);
  const views = useRef(new Map<string, ViewCamera>());
  const [draft, setDraftState] = useState<Experience>(initial);
  const [saved, setSaved] = useState(initialSaved);
  const [baseline, setBaseline] = useState(() => JSON.stringify(initial));
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<RuntimeState | null>(null);
  const [tab, setTab] = useState<Tab>("stops");
  const [openStop, setOpenStop] = useState<string | null>(initial.stops[0]?.id ?? null);
  const [selected, setSelected] = useState<string | null>(null);
  const [gizmo, setGizmo] = useState<GizmoMode>("translate");
  const [preview, setPreview] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [thinking, setThinking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [revision, setRevision] = useState(0);
  const [adding, setAdding] = useState(false);
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const viewerEdits = useMemo(() => ({ ...edits, experience: initial }), [edits, initial]);
  const editor = useMemo(() => ({
    mode: "tour" as const,
    onReady: (runtime: ViewerSession | null) => { session.current = runtime; setReady(Boolean(runtime)); },
    onState: setState,
    onObjectSelect: (id: string | null) => { setSelected(id); if (id) setTab("objects"); },
    onObjectTransform: (id: string, transform: ObjectTransform) => {
      setDraftState((current) => ({ ...current, objects: current.objects.map((object) => object.id === id ? { ...object, ...transform } : object) }));
    }
  }), []);

  /** Live-apply edits to the viewer, a moment after typing stops. */
  const setDraft = useCallback((next: Experience | ((current: Experience) => Experience), immediate = false) => {
    setDraftState((current) => {
      const value = typeof next === "function" ? next(current) : next;
      if (pushTimer.current) clearTimeout(pushTimer.current);
      pushTimer.current = setTimeout(() => {
        void session.current?.setExperience(updateFor(draftRef.current)).then(() => setRevision((count) => count + 1));
      }, immediate ? 0 : 250);
      return value;
    });
  }, []);

  const dirty = JSON.stringify(draft) !== baseline;
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Unsaved drafts and the agent conversation survive a reload of the page.
  const storageKey = `sphr-tour-draft:${scene.sceneId}`;
  const restored = useRef(false);
  useEffect(() => {
    if (!ready || restored.current) return;
    restored.current = true;
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      if (stored?.revision !== saved.revision) return;
      if (Array.isArray(stored.turns)) setTurns(stored.turns.slice(-12));
      if (stored.draft && JSON.stringify(stored.draft) !== baseline) {
        setDraft(parseExperience(stored.draft, { lenient: true }), true);
        setMessage("Your unsaved changes were restored.");
      }
    } catch { /* storage unavailable or stale */ }
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!restored.current) return;
    const timer = setTimeout(() => {
      try {
        if (!dirty && !turns.length) localStorage.removeItem(storageKey);
        else localStorage.setItem(storageKey, JSON.stringify({ revision: saved.revision, draft: dirty ? draft : null, turns }));
      } catch { /* storage full or blocked */ }
    }, 400);
    return () => clearTimeout(timer);
  }, [draft, turns, dirty, saved.revision, storageKey]);

  // Preview plays the tour from its first stop the way visitors see it.
  useEffect(() => {
    const viewer = session.current;
    if (!viewer) return;
    viewer.setEditing(!preview);
    if (preview) {
      viewer.restartHunt();
      viewer.dismissFinale();
      viewer.start(draftRef.current.stops.length > 0);
      if (draftRef.current.stops.length) void viewer.goToStop(0);
    } else viewer.start(draftRef.current.stops.length > 0);
  }, [preview, ready]);
  useEffect(() => { session.current?.setGizmoMode(gizmo); }, [gizmo, ready]);

  const activeStop = state ? draft.stops[state.activePointIndex] : undefined;

  // ---- Agent ----
  async function askAgent() {
    const text = prompt.trim();
    if (!text || thinking) return;
    setThinking(true); setError(""); setMessage("");
    try {
      const capture = session.current?.captureView();
      const viewList = capture ? [{ id: "current", image: capture.image, nodeId: capture.view.nodeId, rotation: capture.view.rotation, fov: capture.view.fov }] : [];
      if (capture) views.current.set("current", capture.camera);
      const response = await fetch(`${api}/agent`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text, experience: draftRef.current, kind: draftRef.current.kind, history: turns, views: viewList })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The agent could not finish. Try again.");
      const placed = placeAnchors(result.experience as Experience, result.anchors);
      setDraft(placed, true);
      setTurns((current) => [...current, { prompt: text, reply: result.reply }]);
      setPrompt("");
      if (placed.stops[0]) { setOpenStop(placed.stops[0].id); setTimeout(() => void session.current?.goToStop(0), 400); }
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setThinking(false);
    }
  }

  /** Turn the agent's pixel placements into positions and headings in the space. */
  function placeAnchors(experience: Experience, anchors: { objects: Record<string, Anchor>; stops: Record<string, Anchor>; effects: Record<string, Anchor> }): Experience {
    const resolve = (anchor: Anchor) => session.current?.resolveAnchor({
      nodeId: anchor.view ? undefined : anchor.nodeId, face: anchor.face, x: anchor.x, y: anchor.y,
      camera: anchor.view ? views.current.get(anchor.view) : undefined
    }) ?? null;
    const objects = experience.objects.map((object) => {
      const anchor = anchors?.objects?.[object.id];
      const spot = anchor ? resolve(anchor) : null;
      return spot ? { ...object, position: spot.position } : object;
    });
    const effects = experience.effects.map((effect) => {
      const anchor = anchors?.effects?.[effect.id];
      const spot = anchor ? resolve(anchor) : null;
      return spot && effect.target.kind === "point" ? { ...effect, target: { kind: "point" as const, position: spot.position } } : effect;
    });
    // A stop looks from where it stands toward the spot the agent pointed at, even
    // when that spot was picked in a photo taken somewhere else.
    const stops = experience.stops.map((stop) => {
      const anchor = anchors?.stops?.[stop.id];
      const spot = anchor ? resolve(anchor) : null;
      if (!spot) return stop;
      const aimed = stop.view.nodeId && spot.hit ? session.current?.aimFrom(stop.view.nodeId, spot.position) : null;
      const rotation = aimed ?? { azimuth: Number(spot.rotation.azimuth.toFixed(2)), polar: Number(spot.rotation.polar.toFixed(2)) };
      return { ...stop, view: { ...stop.view, rotation } };
    });
    try { return parseExperience({ ...experience, objects, effects, stops }, { lenient: true }); }
    catch { return { ...experience, objects, effects, stops }; }
  }

  // ---- Save ----
  async function save(remove = false) {
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch(api, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: saved.revision, experience: remove ? null : draft })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to save. Try again.");
      setSaved(result.tour);
      setBaseline(JSON.stringify(remove ? draft : result.tour.experience ?? draft));
      setMessage(remove ? "The authored tour was removed. Visitors see the original space." : "Saved. Visitors see this tour now.");
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }

  // ---- Stops ----
  function patchStop(id: string, patch: Partial<ExperienceStop>) {
    setDraft((current) => ({ ...current, stops: current.stops.map((stop) => stop.id === id ? { ...stop, ...patch } : stop) }));
  }
  function addStop() {
    const view = session.current?.cameraView();
    if (!view) return;
    const id = newId("stop", draft.stops.map((stop) => stop.id));
    const stop: ExperienceStop = { id, title: `Stop ${draft.stops.length + 1}`, text: "", view, objects: [], effects: [] };
    setDraft((current) => ({ ...current, stops: [...current.stops, stop] }), true);
    setOpenStop(id);
  }
  function moveStop(index: number, direction: -1 | 1) {
    setDraft((current) => {
      const stops = [...current.stops];
      const target = index + direction;
      if (target < 0 || target >= stops.length) return current;
      [stops[index], stops[target]] = [stops[target], stops[index]];
      return { ...current, stops };
    }, true);
  }
  function toggle(list: string[], id: string) { return list.includes(id) ? list.filter((item) => item !== id) : [...list, id]; }

  // ---- Objects ----
  function addObject(source: PlacedObject["source"], name: string) {
    const spot = session.current?.resolveAnchor({ x: 0.5, y: 0.62 });
    const id = newId("object", draft.objects.map((object) => object.id));
    const object: PlacedObject = {
      id, name, source,
      position: spot?.position ?? [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
      ...(draft.kind === "tour" && !activeStop ? { always: true } : {})
    };
    setDraft((current) => ({
      ...current,
      objects: [...current.objects, object],
      stops: activeStop && !object.always ? current.stops.map((stop) => stop.id === activeStop.id ? { ...stop, objects: [...stop.objects, id] } : stop) : current.stops
    }), true);
    setAdding(false);
    setTimeout(() => session.current?.selectObject(id), 600);
  }
  function patchObject(id: string, patch: Partial<PlacedObject>) {
    setDraft((current) => ({ ...current, objects: current.objects.map((object) => object.id === id ? { ...object, ...patch } : object) }));
  }
  function removeObject(id: string) {
    setDraft((current) => ({
      ...current,
      objects: current.objects.filter((object) => object.id !== id),
      effects: current.effects.filter((effect) => !(effect.target.kind === "object" && effect.target.id === id)),
      stops: current.stops.map((stop) => ({ ...stop, objects: stop.objects.filter((item) => item !== id), find: stop.find?.objectId === id ? undefined : stop.find }))
    }), true);
    if (selected === id) session.current?.selectObject(null);
  }

  // ---- Effects ----
  function addEffect(type: string) {
    const entry = effectEntry(type);
    if (!entry) return;
    const id = newId(type, draft.effects.map((effect) => effect.id));
    const target: EffectInstance["target"] = selected && entry.targets.includes("object") ? { kind: "object", id: selected }
      : entry.targets.includes("scene") ? { kind: "scene" }
      : { kind: "point", position: session.current?.resolveAnchor({ x: 0.5, y: 0.6 })?.position ?? [0, 0, 0] };
    const effect: EffectInstance = { id, type, target, params: resolveParams(entry, {}), ...(activeStop ? {} : { always: true }) };
    setDraft((current) => ({
      ...current,
      effects: [...current.effects, effect],
      stops: activeStop ? current.stops.map((stop) => stop.id === activeStop.id ? { ...stop, effects: [...stop.effects, id] } : stop) : current.stops
    }), true);
  }
  function patchEffect(id: string, patch: Partial<EffectInstance>) {
    setDraft((current) => ({ ...current, effects: current.effects.map((effect) => effect.id === id ? { ...effect, ...patch } : effect) }));
  }
  function removeEffect(id: string) {
    setDraft((current) => ({ ...current, effects: current.effects.filter((effect) => effect.id !== id), stops: current.stops.map((stop) => ({ ...stop, effects: stop.effects.filter((item) => item !== id) })) }), true);
  }

  const setKind = (kind: ExperienceKind) => setDraft((current) => ({ ...current, kind }), true);
  const objectName = (id: string) => draft.objects.find((object) => object.id === id)?.name ?? id;
  const selectedObject = draft.objects.find((object) => object.id === selected) ?? null;
  const canEdit = ready && state?.loading.ready;
  const splatSpace = scene.sourceType === "splat";
  const hunt = draft.kind === "hunt";

  return <div className="tour-builder">
    <section className="tour-builder-view" aria-label="Space">
      <SphrApp configUrl={scene.bootstrapUrl} edits={viewerEdits} editor={editor} chrome={preview} revision={revision} preview={{ title: scene.title, image: scene.thumbnail }} />
      {canEdit && <div className="builder-toolbar" data-preview={preview} role="toolbar" aria-label="Viewer tools">
        <button type="button" aria-pressed={preview} onClick={() => setPreview((value) => !value)}><Eye size={18} aria-hidden="true" /> {preview ? "Back to editing" : "Preview as a visitor"}</button>
        {!preview && selectedObject && <>
          <button type="button" aria-pressed={gizmo === "translate"} onClick={() => setGizmo("translate")}><Move3d size={18} aria-hidden="true" /> Move</button>
          <button type="button" aria-pressed={gizmo === "rotate"} onClick={() => setGizmo("rotate")}><Rotate3d size={18} aria-hidden="true" /> Turn</button>
          <button type="button" aria-pressed={gizmo === "scale"} onClick={() => setGizmo("scale")}><Scale3d size={18} aria-hidden="true" /> Size</button>
          <button type="button" aria-label="Deselect" onClick={() => session.current?.selectObject(null)}><X size={18} aria-hidden="true" /></button>
        </>}
      </div>}
    </section>

    <aside className="tour-builder-panel">
      <div className="builder-scroll">
        <nav aria-label="Builder"><a href={back.href}>← {back.label}</a><a href={scene.scenePath} target="_blank" rel="noreferrer">View space ↗</a></nav>
        <h1>{scene.title}</h1>
        <div className="builder-kind" role="radiogroup" aria-label="What to make">
          <button type="button" role="radio" aria-checked={!hunt} onClick={() => setKind("tour")}>Guided tour</button>
          <button type="button" role="radio" aria-checked={hunt} onClick={() => setKind("hunt")}>Scavenger hunt</button>
        </div>

        <form className="builder-agent" onSubmit={(event) => { event.preventDefault(); void askAgent(); }}>
          <label htmlFor="agent-prompt">Tell your agent what to make</label>
          <textarea id="agent-prompt" value={prompt} rows={6} maxLength={6000} disabled={thinking || !agentReady}
            placeholder={hunt
              ? "Hide five small treasures around this space for kids, with clues that rhyme and a hint for each."
              : "Walk visitors through this space in five stops, starting at the entrance. Sweep a scan of light across everything at the start and let sparkles follow the pointer."}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void askAgent(); } }} />
          {!agentReady && <p className="editor-help">No agent is connected to this site yet. You can still build the tour by hand below.</p>}
          <button type="submit" className="builder-send" disabled={thinking || !prompt.trim() || !agentReady || !canEdit}>
            {thinking ? <><Sparkles size={18} aria-hidden="true" className="builder-spin" /> Your agent is working on it</> : <><Send size={18} aria-hidden="true" /> Send</>}
          </button>
          {turns.length > 0 && <ol className="builder-turns" aria-label="Conversation">
            {turns.map((turn, index) => <li key={index}><p className="builder-turn-prompt">{turn.prompt}</p><p>{turn.reply}</p></li>)}
          </ol>}
        </form>

        <div className="builder-tabs" role="tablist" aria-label="Tour parts">
          {(["stops", "objects", "effects"] as Tab[]).map((value) => <button key={value} role="tab" type="button" aria-selected={tab === value} onClick={() => setTab(value)}>
            {value === "stops" ? `${hunt ? "Clues" : "Stops"} ${draft.stops.length}` : value === "objects" ? `Objects ${draft.objects.length}` : `Effects ${draft.effects.length}`}
          </button>)}
        </div>

        {tab === "stops" && <div role="tabpanel" className="builder-list">
          {draft.stops.map((stop, index) => {
            const open = openStop === stop.id;
            const current = state?.activePointIndex === index;
            return <article key={stop.id} className={`builder-card${open ? " open" : ""}${current ? " current" : ""}`}>
              <header>
                <button type="button" className="builder-card-title" aria-expanded={open} onClick={() => { setOpenStop(open ? null : stop.id); void session.current?.goToStop(index); }}>
                  <span className="builder-index">{index + 1}</span>{stop.title || (hunt ? "Untitled clue" : "Untitled stop")}
                </button>
                <span className="builder-card-actions">
                  <button type="button" aria-label="Move up" disabled={index === 0} onClick={() => moveStop(index, -1)}><ArrowUp size={16} /></button>
                  <button type="button" aria-label="Move down" disabled={index === draft.stops.length - 1} onClick={() => moveStop(index, 1)}><ArrowDown size={16} /></button>
                </span>
              </header>
              {open && <div className="builder-card-body">
                <label>Title<input value={stop.title} maxLength={200} onChange={(event) => patchStop(stop.id, { title: event.target.value })} /></label>
                <label>{hunt ? "Clue" : "Text"}<textarea rows={5} value={stop.text} maxLength={4000} onChange={(event) => patchStop(stop.id, { text: event.target.value })} /></label>
                {!hunt && <label>More detail<textarea rows={2} value={stop.detail ?? ""} maxLength={4000} onChange={(event) => patchStop(stop.id, { detail: event.target.value })} /></label>}
                {hunt && <>
                  <label>Object to find<select value={stop.find?.objectId ?? ""} onChange={(event) => patchStop(stop.id, { find: event.target.value ? { ...stop.find, objectId: event.target.value } : undefined })}>
                    <option value="">Choose an object</option>
                    {draft.objects.map((object) => <option key={object.id} value={object.id}>{object.name}</option>)}
                  </select></label>
                  <label>Hint<textarea rows={2} value={stop.find?.hint ?? ""} maxLength={1000} disabled={!stop.find} onChange={(event) => stop.find && patchStop(stop.id, { find: { ...stop.find, hint: event.target.value } })} /></label>
                  <label>When it is found<textarea rows={3} value={stop.find?.found ?? ""} maxLength={4000} disabled={!stop.find} onChange={(event) => stop.find && patchStop(stop.id, { find: { ...stop.find, found: event.target.value } })} /></label>
                </>}
                {draft.objects.length > 0 && <fieldset><legend>Objects shown here</legend><div className="builder-chips">
                  {draft.objects.filter((object) => !object.always).map((object) => <button type="button" key={object.id} aria-pressed={stop.objects.includes(object.id)} onClick={() => patchStop(stop.id, { objects: toggle(stop.objects, object.id) })}>{object.name}</button>)}
                </div></fieldset>}
                {draft.effects.length > 0 && <fieldset><legend>Effects here</legend><div className="builder-chips">
                  {draft.effects.filter((effect) => !effect.always).map((effect) => <button type="button" key={effect.id} aria-pressed={stop.effects.includes(effect.id)} onClick={() => patchStop(stop.id, { effects: toggle(stop.effects, effect.id) })}>{effect.name || effectEntry(effect.type)?.label || effect.type}</button>)}
                </div></fieldset>}
                <div className="builder-row">
                  <button type="button" onClick={() => { const view = session.current?.cameraView(); if (view) patchStop(stop.id, { view }); setMessage("This stop now opens on the current view."); }}><Camera size={16} aria-hidden="true" /> Use the current view</button>
                  <button type="button" className="builder-danger" onClick={() => setDraft((current) => ({ ...current, stops: current.stops.filter((item) => item.id !== stop.id) }), true)}><Trash2 size={16} aria-hidden="true" /> Remove</button>
                </div>
              </div>}
            </article>;
          })}
          <button type="button" className="builder-add" disabled={!canEdit} onClick={addStop}><Plus size={16} aria-hidden="true" /> {hunt ? "Add a clue at the current view" : "Add a stop at the current view"}</button>
          <label className="builder-finale">{hunt ? "When everything is found" : "After the last stop"}<textarea rows={3} value={draft.finale ?? ""} maxLength={4000} onChange={(event) => setDraft((current) => ({ ...current, finale: event.target.value }))} /></label>
        </div>}

        {tab === "objects" && <div role="tabpanel" className="builder-list">
          <button type="button" className="builder-add" disabled={!canEdit} aria-expanded={adding} onClick={() => setAdding((value) => !value)}><Plus size={16} aria-hidden="true" /> Add an object where you are looking</button>
          {adding && <div className="builder-picker">
            <p className="builder-picker-heading">Shapes</p>
            <div className="builder-grid">{shapeEntries().map((entry) => <button type="button" key={entry.shape} onClick={() => addObject({ kind: "shape", shape: entry.shape, ...(entry.text ? { text: "Your text here" } : {}) }, entry.label)}><span className="builder-swatch" style={{ background: entry.color }} />{entry.label}</button>)}</div>
            {library.length > 0 && <LibraryPicker library={library} onAdd={(model) => addObject({ kind: "model", url: model.url }, model.name)} />}
            <ModelUrl onAdd={(url) => addObject({ kind: "model", url }, url.split("/").pop()?.replace(/\.(glb|gltf)(\?.*)?$/i, "") || "Model")} />
          </div>}
          {draft.objects.map((object) => <article key={object.id} className={`builder-card${selected === object.id ? " open current" : ""}`}>
            <header><button type="button" className="builder-card-title" onClick={() => {
              if (selected === object.id) { session.current?.selectObject(null); return; }
              session.current?.selectObject(object.id);
              session.current?.lookAtObject(object.id);
            }}>{object.name}</button>
              <span className="builder-card-actions"><button type="button" aria-label={`Remove ${object.name}`} onClick={() => removeObject(object.id)}><Trash2 size={16} /></button></span></header>
            {selected === object.id && <div className="builder-card-body">
              <label>Name<input value={object.name} maxLength={120} onChange={(event) => patchObject(object.id, { name: event.target.value })} /></label>
              {object.source.kind === "shape" && <div className="builder-row">
                <label className="builder-color">Color<input type="color" value={object.source.color ?? shapeEntry(object.source.shape)?.color ?? "#ffffff"} onChange={(event) => patchObject(object.id, { source: { ...object.source as Extract<PlacedObject["source"], { kind: "shape" }>, color: event.target.value } })} /></label>
              </div>}
              {object.source.kind === "shape" && shapeEntry(object.source.shape)?.text && <label>Sign text<textarea rows={2} maxLength={300} value={object.source.text ?? ""} onChange={(event) => patchObject(object.id, { source: { ...object.source as Extract<PlacedObject["source"], { kind: "shape" }>, text: event.target.value } })} /></label>}
              <label>Label on hover<input value={object.label ?? ""} maxLength={300} onChange={(event) => patchObject(object.id, { label: event.target.value })} /></label>
              <div className="builder-row">
                <label>Motion<select value={object.idle ?? "none"} onChange={(event) => patchObject(object.id, { idle: event.target.value as PlacedObject["idle"] })}>
                  <option value="none">Still</option><option value="spin">Spin</option><option value="bob">Bob</option><option value="float">Float</option>
                </select></label>
                <label className="builder-check"><input type="checkbox" checked={Boolean(object.always)} onChange={(event) => patchObject(object.id, { always: event.target.checked })} /> Always shown</label>
              </div>
              <Transform label="Position (m)" value={object.position} step={0.05} onChange={(position) => patchObject(object.id, { position })} />
              <Transform label="Turn (degrees)" value={object.rotation} step={5} onChange={(rotation) => patchObject(object.id, { rotation })} />
              <Transform label="Size" value={object.scale} step={0.1} onChange={(scale) => patchObject(object.id, { scale: scale.map((value) => Math.max(0.001, value)) as Vec3 })} />
              <button type="button" onClick={() => { const spot = session.current?.resolveAnchor({ x: 0.5, y: 0.62 }); if (spot) patchObject(object.id, { position: spot.position }); }}>Drop it where I am looking</button>
            </div>}
          </article>)}
          {!draft.objects.length && <p className="editor-help">Place shapes, library models or your own glTF models. Select one in the space to move, turn or resize it.</p>}
        </div>}

        {tab === "effects" && <div role="tabpanel" className="builder-list">
          <label className="builder-add-effect">Add an effect<select value="" disabled={!canEdit} onChange={(event) => { if (event.target.value) addEffect(event.target.value); }}>
            <option value="">Choose an effect</option>
            {effectEntries().map((entry) => <option key={entry.type} value={entry.type} disabled={entry.requires === "splats" && !splatSpace}>{entry.label}{entry.requires === "splats" && !splatSpace ? " (splat spaces)" : ""}</option>)}
          </select></label>
          {draft.effects.map((effect) => <EffectCard key={effect.id} effect={effect} objects={draft.objects} objectName={objectName}
            onChange={(patch) => patchEffect(effect.id, patch)} onRemove={() => removeEffect(effect.id)}
            onHere={() => { const spot = session.current?.resolveAnchor({ x: 0.5, y: 0.6 }); if (spot) patchEffect(effect.id, { target: { kind: "point", position: spot.position } }); }} />)}
          {!draft.effects.length && <p className="editor-help">Effects added while a stop is open run at that stop. Effects added with no stops run all the time.</p>}
        </div>}
      </div>

      <div className="builder-footer">
        <div className="editor-feedback" aria-live="polite">{message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}</div>
        <div className="builder-row">
          {saved.experience && <button type="button" className="builder-quiet" disabled={busy} onClick={() => { if (window.confirm("Remove the authored tour? Visitors will see the space as it was.")) void save(true); }}>Remove tour</button>}
          <button type="button" className="editor-save" disabled={busy || !dirty} onClick={() => void save()}>{busy ? "Saving" : dirty ? "Save" : "Saved"}</button>
        </div>
      </div>
    </aside>
  </div>;
}

function Transform({ label, value, step, onChange }: { label: string; value: Vec3; step: number; onChange: (value: Vec3) => void }) {
  return <fieldset className="builder-transform"><legend>{label}</legend>
    {(["x", "y", "z"] as const).map((axis, index) => <label key={axis}><span>{axis}</span>
      <input type="number" step={step} value={Number(value[index].toFixed(3))} onChange={(event) => {
        const number = Number(event.target.value);
        if (!Number.isFinite(number)) return;
        const next = [...value] as Vec3; next[index] = number; onChange(next);
      }} /></label>)}
  </fieldset>;
}

/** Library models grouped by category, with a search across names, categories and tags. */
function LibraryPicker({ library, onAdd }: { library: LibraryModel[]; onAdd: (model: LibraryModel) => void }) {
  const [query, setQuery] = useState("");
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = library.filter((model) => words.every((word) => `${model.name} ${model.category} ${model.pack ?? ""} ${(model.tags ?? []).join(" ")}`.toLowerCase().includes(word)));
  const categories = [...new Set(matches.map((model) => model.category))];
  return <div className="builder-library">
    <label className="builder-picker-heading" htmlFor="library-search">Library</label>
    <input id="library-search" type="search" placeholder="Search coins, chests, arrows, plants" value={query} onChange={(event) => setQuery(event.target.value)} />
    {categories.map((category) => <div key={category}>
      <p className="builder-picker-heading">{category}</p>
      <div className="builder-grid">{matches.filter((model) => model.category === category).map((model) => <button type="button" key={model.id} title={`${model.name}, about ${model.height < 1 ? `${Math.round(model.height * 100)} cm` : `${model.height.toFixed(1)} m`} tall`} onClick={() => onAdd(model)}>
        {model.thumbnail ? <img src={model.thumbnail} alt="" width={36} height={36} loading="lazy" /> : <span className="builder-swatch" />}{model.name}</button>)}</div>
    </div>)}
    {!matches.length && <p className="editor-help">No models match.</p>}
  </div>;
}

function ModelUrl({ onAdd }: { onAdd: (url: string) => void }) {
  const [url, setUrl] = useState("");
  const valid = /^https:\/\/\S+\.(glb|gltf)(\?\S*)?$/i.test(url.trim());
  return <form className="builder-url" onSubmit={(event) => { event.preventDefault(); if (valid) { onAdd(url.trim()); setUrl(""); } }}>
    <label htmlFor="model-url">Your own model (a glTF or GLB address)</label>
    <div className="builder-row"><input id="model-url" type="url" placeholder="https://example.com/statue.glb" value={url} onChange={(event) => setUrl(event.target.value)} /><button type="submit" disabled={!valid}>Add</button></div>
  </form>;
}

function EffectCard({ effect, objects, objectName, onChange, onRemove, onHere }: {
  effect: EffectInstance; objects: PlacedObject[]; objectName: (id: string) => string;
  onChange: (patch: Partial<EffectInstance>) => void; onRemove: () => void; onHere: () => void;
}) {
  const entry = effectEntry(effect.type);
  const [open, setOpen] = useState(false);
  if (!entry) return null;
  const targetValue = effect.target.kind === "object" ? `object:${effect.target.id}` : effect.target.kind;
  return <article className={`builder-card${open ? " open" : ""}`}>
    <header><button type="button" className="builder-card-title" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      {effect.name || entry.label}<span className="builder-card-meta">{effect.target.kind === "object" ? objectName(effect.target.id) : effect.target.kind === "point" ? "at a spot" : "whole space"}</span></button>
      <span className="builder-card-actions"><button type="button" aria-label={`Remove ${entry.label}`} onClick={onRemove}><Trash2 size={16} /></button></span></header>
    {open && <div className="builder-card-body">
      <p className="editor-help">{entry.description}</p>
      <label>Applies to<select value={targetValue} onChange={(event) => {
        const value = event.target.value;
        if (value === "scene") onChange({ target: { kind: "scene" } });
        else if (value === "point") onHere();
        else onChange({ target: { kind: "object", id: value.slice(7) } });
      }}>
        {entry.targets.includes("scene") && <option value="scene">The whole space</option>}
        {entry.targets.includes("point") && <option value="point">{effect.target.kind === "point" ? "This spot" : "Where I am looking"}</option>}
        {entry.targets.includes("object") && objects.map((object) => <option key={object.id} value={`object:${object.id}`}>{object.name}</option>)}
      </select></label>
      {effect.target.kind === "point" && <button type="button" onClick={onHere}>Move it where I am looking</button>}
      {entry.params.map((param) => <Param key={param.key} spec={param} value={effect.params[param.key]} onChange={(value) => onChange({ params: { ...effect.params, [param.key]: value } })} />)}
      <label className="builder-check"><input type="checkbox" checked={Boolean(effect.always)} onChange={(event) => onChange({ always: event.target.checked })} /> Runs the whole time</label>
    </div>}
  </article>;
}

function Param({ spec, value, onChange }: { spec: ParamSpec; value: unknown; onChange: (value: number | string | boolean) => void }) {
  if (spec.type === "number") {
    const number = typeof value === "number" ? value : spec.default;
    return <label className="builder-range">{spec.label}<span>{number}</span>
      <input type="range" min={spec.min} max={spec.max} step={spec.step ?? (spec.max - spec.min) / 100} value={number} onChange={(event) => onChange(Number(event.target.value))} /></label>;
  }
  if (spec.type === "color") return <label className="builder-color">{spec.label}<input type="color" value={typeof value === "string" ? value : spec.default} onChange={(event) => onChange(event.target.value)} /></label>;
  if (spec.type === "boolean") return <label className="builder-check"><input type="checkbox" checked={typeof value === "boolean" ? value : spec.default} onChange={(event) => onChange(event.target.checked)} /> {spec.label}</label>;
  return <label>{spec.label}<select value={typeof value === "string" ? value : spec.default} onChange={(event) => onChange(event.target.value)}>
    {spec.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select></label>;
}
