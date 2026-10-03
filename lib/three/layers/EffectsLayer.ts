import * as THREE from "three";
import { effectEntry } from "@/lib/experience/packs";
import { resolveParams, type AudioHost, type EffectContext, type EffectHandle, type PointerHit, type SplatHost } from "@/lib/experience/registry";
import type { EffectInstance } from "@/lib/experience/types";
import type { ObjectLayer } from "./ObjectLayer";
import type { PanoramaStyle } from "@/lib/three/renderers/PanoramaLayer";

type EffectRecord = {
  instance: EffectInstance;
  handle: EffectHandle | null;
  key: string;
  active: boolean;
  transient?: number;
};

export type EffectsHost = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  objects: ObjectLayer;
  surfaces: () => THREE.Mesh[];
  spaceBounds: (out: THREE.Box3) => THREE.Box3;
  splats: () => SplatHost | null;
  panorama: () => PanoramaStyle | null;
  viewMode: () => "FPV" | "ORBIT";
  audio: () => AudioHost;
};

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Runs effect instances from the installed packs and switches them per stop. */
export class EffectsLayer {
  private readonly records = new Map<string, EffectRecord>();
  private activeIds = new Set<string>();
  private disposed = false;
  private transientCount = 0;

  constructor(private readonly host: EffectsHost) {}

  /** Create, update and remove effects to match the list. */
  async setEffects(effects: EffectInstance[]) {
    const ids = new Set(effects.map((effect) => effect.id));
    for (const [id, record] of this.records) {
      if (!record.transient && !ids.has(id)) { record.handle?.dispose(); this.records.delete(id); }
    }
    const loads: Promise<void>[] = [];
    for (const instance of effects) {
      const key = `${instance.type}|${JSON.stringify(instance.target)}`;
      const record = this.records.get(instance.id);
      if (record && record.key === key) {
        record.instance = instance;
        record.handle?.setParams?.(instance.params);
        continue;
      }
      record?.handle?.dispose();
      const next: EffectRecord = { instance, handle: null, key, active: false };
      this.records.set(instance.id, next);
      loads.push(this.load(next));
    }
    await Promise.all(loads);
    this.applyActive();
  }

  /** Effects listed by the current stop, plus those marked always. */
  activate(ids: Iterable<string>) {
    this.activeIds = new Set(ids);
    this.applyActive();
  }

  /** Cue every effect aimed at an object, e.g. "found" when a hunt item is picked up. */
  cue(objectId: string, cue: "found" | "hint" | "click") {
    let handled = false;
    for (const record of this.records.values()) {
      const target = record.instance.target;
      if (record.transient || target.kind !== "object" || target.id !== objectId || !record.handle?.play) continue;
      record.handle.play(cue);
      handled = true;
    }
    return handled;
  }

  /** Whether the tour has its own sound for this cue on an object. */
  hasSound(objectId: string, cue: "found" | "hint" | "click") {
    for (const record of this.records.values()) {
      const target = record.instance.target;
      if (!record.transient && record.instance.type === "sound" && target.kind === "object" && target.id === objectId && record.instance.params.trigger === cue) return true;
    }
    return false;
  }

  /** A short-lived effect for a hunt find or hint when the tour defines none. */
  async flash(type: string, objectId: string, cue: "found" | "hint", params: Record<string, number | string | boolean> = {}, seconds = 4) {
    const entry = effectEntry(type);
    if (!entry) return;
    this.transientCount += 1;
    const instance: EffectInstance = {
      id: `transient-${this.transientCount}`, type, target: { kind: "object", id: objectId },
      params: resolveParams(entry, params)
    };
    const record: EffectRecord = { instance, handle: null, key: "", active: true, transient: seconds };
    this.records.set(instance.id, record);
    await this.load(record);
    record.handle?.setActive(true);
    record.handle?.play?.(cue);
  }

  pointer(hit: PointerHit | null) {
    for (const record of this.records.values()) if (record.active) record.handle?.pointer?.(hit);
  }

  /** Whether any running effect reacts to the pointer over the space. */
  wantsPointer() {
    for (const record of this.records.values()) if (record.active && record.instance.params.mode === "hover") return true;
    return false;
  }

  update(time: number, delta: number) {
    for (const [id, record] of this.records) {
      if (record.transient !== undefined) {
        record.transient -= delta;
        if (record.transient < 1 && record.active) { record.active = false; record.handle?.setActive(false); }
        if (record.transient <= 0) { record.handle?.dispose(); this.records.delete(id); continue; }
      }
      record.handle?.update({ time, delta, camera: this.host.camera });
    }
  }

  dispose() {
    this.disposed = true;
    for (const record of this.records.values()) record.handle?.dispose();
    this.records.clear();
  }

  private applyActive() {
    for (const record of this.records.values()) {
      if (record.transient !== undefined) continue;
      const active = Boolean(record.instance.always) || this.activeIds.has(record.instance.id);
      if (active !== record.active) {
        record.active = active;
        record.handle?.setActive(active);
      }
    }
  }

  private async load(record: EffectRecord) {
    const entry = effectEntry(record.instance.type);
    if (!entry) return;
    try {
      const factory = (await entry.load()).default;
      if (this.disposed || (this.records.get(record.instance.id) !== record)) return;
      record.handle = factory(this.context(record), record.instance);
      if (record.active) record.handle.setActive(true);
    } catch (error) {
      console.warn(`Unable to start effect ${record.instance.type}`, error);
    }
  }

  private context(record: EffectRecord): EffectContext {
    const { host } = this;
    const objectId = () => record.instance.target.kind === "object" ? record.instance.target.id : null;
    const box = new THREE.Box3();
    return {
      scene: host.scene,
      camera: host.camera,
      renderer: host.renderer,
      object: () => {
        const id = objectId();
        return id ? host.objects.getHolder(id) : null;
      },
      anchor: (out) => {
        const target = record.instance.target;
        if (target.kind === "point") return out.set(...target.position);
        if (target.kind === "object") return host.objects.bounds(target.id, box).getCenter(out);
        const bounds = host.spaceBounds(box);
        return bounds.isEmpty() ? out.set(0, 0, 0) : bounds.getCenter(out);
      },
      bounds: (out) => {
        const id = objectId();
        return id ? host.objects.bounds(id, out) : host.spaceBounds(out);
      },
      spaceBounds: (out) => host.spaceBounds(out),
      surfaces: () => host.surfaces(),
      splats: host.splats(),
      panorama: host.panorama(),
      viewMode: () => host.viewMode(),
      audio: () => host.audio(),
      reducedMotion: reducedMotion()
    };
  }
}
