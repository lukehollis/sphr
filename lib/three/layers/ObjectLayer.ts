import * as THREE from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { shapeEntry } from "@/lib/experience/packs";
import type { PlacedObject } from "@/lib/experience/types";

type ObjectRecord = {
  data: PlacedObject;
  /** Authored transform; the editor gizmo moves this group. */
  holder: THREE.Group;
  /** Idle motion and appear/collect animation, inside the authored transform. */
  motion: THREE.Group;
  content: THREE.Object3D | null;
  sourceKey: string;
  shown: number;
  wanted: boolean;
  collect: number | null;
  phase: number;
  /** Plays an animated model's clip. */
  mixer: THREE.AnimationMixer | null;
  clip: string;
};

const DEG = THREE.MathUtils.DEG2RAD;

function sourceKey(object: PlacedObject) {
  return JSON.stringify(object.source) + (object.source.kind === "shape" ? `|${object.name}` : "");
}

/**
 * Custom objects placed in a space: pack shapes, glTF models and image cards.
 * Objects render in the transparent pass after the capture's depth occluder,
 * so walls in a panorama hide what is behind them.
 */
export class ObjectLayer {
  readonly root = new THREE.Group();
  private readonly records = new Map<string, ObjectRecord>();
  private readonly loader = new GLTFLoader();
  private readonly models = new Map<string, Promise<GLTF>>();
  private readonly textures = new THREE.TextureLoader();
  private readonly box = new THREE.Box3();
  private editing = false;
  private disposed = false;

  constructor(private readonly scene: THREE.Scene, private readonly onLoaded: () => void = () => {}) {
    this.root.name = "experience-objects";
    const draco = new DRACOLoader();
    draco.setDecoderPath("https://www.gstatic.com/draco/v1/decoders/");
    this.loader.setDRACOLoader(draco);
    this.loader.setMeshoptDecoder(MeshoptDecoder);
    this.scene.add(this.root);
  }

  /** Add, update and remove objects to match the list; unchanged sources are kept. */
  async setObjects(objects: PlacedObject[]) {
    const ids = new Set(objects.map((object) => object.id));
    for (const [id, record] of this.records) {
      if (!ids.has(id)) { this.root.remove(record.holder); this.disposeContent(record); this.records.delete(id); }
    }
    const loads: Promise<void>[] = [];
    for (const data of objects) {
      let record = this.records.get(data.id);
      if (!record) {
        const holder = new THREE.Group();
        holder.name = `object-${data.id}`;
        holder.userData.objectId = data.id;
        const motion = new THREE.Group();
        holder.add(motion);
        this.root.add(holder);
        record = { data, holder, motion, content: null, sourceKey: "", shown: 0, wanted: false, collect: null, phase: Math.random() * Math.PI * 2, mixer: null, clip: "" };
        this.records.set(data.id, record);
      }
      record.data = data;
      this.applyTransform(record);
      const key = sourceKey(data);
      if (key !== record.sourceKey) {
        record.sourceKey = key;
        loads.push(this.build(record, key));
      } else if ((data.animation ?? "") !== record.clip) {
        this.play(record);
      }
    }
    await Promise.all(loads);
  }

  /** Which objects should be on screen now. Hidden objects shrink away. */
  show(ids: Iterable<string>) {
    const wanted = new Set(ids);
    for (const [id, record] of this.records) record.wanted = this.editing || wanted.has(id) || Boolean(record.data.always);
  }

  /** In the editor every object stays visible so it can be selected. */
  setEditing(editing: boolean) {
    this.editing = editing;
    for (const record of this.records.values()) {
      if (editing) { record.wanted = true; record.collect = null; }
    }
  }

  /** Play the hunt's pick-up animation, then keep the object hidden. */
  collect(id: string) {
    const record = this.records.get(id);
    if (record && record.collect === null) record.collect = 0;
  }

  resetCollected() {
    for (const record of this.records.values()) record.collect = null;
  }

  isCollected(id: string) {
    const record = this.records.get(id);
    return Boolean(record && record.collect !== null);
  }

  getHolder(id: string) {
    return this.records.get(id)?.holder ?? null;
  }

  getData(id: string) {
    return this.records.get(id)?.data ?? null;
  }

  bounds(id: string, out: THREE.Box3) {
    out.makeEmpty();
    const record = this.records.get(id);
    if (!record) return out;
    record.holder.updateMatrixWorld(true);
    if (record.content) out.expandByObject(record.content);
    if (out.isEmpty()) out.setFromCenterAndSize(record.holder.getWorldPosition(new THREE.Vector3()), new THREE.Vector3(0.3, 0.3, 0.3));
    return out;
  }

  /** The visible object under a ray, by ID. */
  pick(raycaster: THREE.Raycaster) {
    const targets: THREE.Object3D[] = [];
    for (const record of this.records.values()) {
      if (record.holder.visible && record.content && record.shown > 0.5 && record.collect === null) targets.push(record.content);
    }
    if (!targets.length) return null;
    const hit = raycaster.intersectObjects(targets, true)[0];
    if (!hit) return null;
    let node: THREE.Object3D | null = hit.object;
    while (node && node.userData.objectId === undefined) node = node.parent;
    return node ? { id: node.userData.objectId as string, distance: hit.distance, point: hit.point } : null;
  }

  update(delta: number, time: number) {
    for (const record of this.records.values()) {
      const target = record.wanted ? 1 : 0;
      record.shown += (target - record.shown) * Math.min(1, delta * 6);
      if (Math.abs(record.shown - target) < 0.002) record.shown = target;
      let scale = easeOutBack(record.shown);
      let lift = 0;
      let spin = 0;
      if (record.collect !== null) {
        record.collect = Math.min(1.6, record.collect + delta);
        const t = record.collect;
        lift = t * t * 1.2;
        spin = t * t * 14;
        scale *= t < 0.25 ? 1 + t * 1.2 : Math.max(0, 1.3 - (t - 0.25) * 1.4);
      }
      record.holder.visible = scale > 0.001;
      const idle = record.data.idle ?? "none";
      const phase = time + record.phase;
      record.motion.position.y = lift + (idle === "bob" ? Math.sin(phase * 2) * 0.05 : idle === "float" ? 0.08 + Math.sin(phase * 1.2) * 0.08 : 0);
      record.motion.rotation.y = spin + (idle === "spin" ? time * 1.2 : idle === "float" ? Math.sin(phase * 0.6) * 0.3 : 0);
      record.motion.scale.setScalar(Math.max(0.0001, scale));
      if (record.holder.visible) record.mixer?.update(delta);
    }
  }

  dispose() {
    this.disposed = true;
    this.scene.remove(this.root);
    for (const record of this.records.values()) this.disposeContent(record);
    this.records.clear();
  }

  private applyTransform(record: ObjectRecord) {
    const { position, rotation, scale } = record.data;
    record.holder.position.set(...position);
    record.holder.rotation.set(rotation[0] * DEG, rotation[1] * DEG, rotation[2] * DEG);
    record.holder.scale.set(...scale);
  }

  private async build(record: ObjectRecord, key: string) {
    let content: THREE.Object3D;
    try {
      content = await this.createContent(record.data);
    } catch (error) {
      console.warn(`Unable to load object ${record.data.id}`, error);
      content = placeholder();
    }
    if (this.disposed || record.sourceKey !== key || this.records.get(record.data.id) !== record) {
      disposeTree(content);
      return;
    }
    this.disposeContent(record);
    prepareForOcclusion(content);
    record.content = content;
    record.motion.add(content);
    this.play(record);
    this.onLoaded();
  }

  private async createContent(data: PlacedObject): Promise<THREE.Object3D> {
    const source = data.source;
    if (source.kind === "shape") {
      const entry = shapeEntry(source.shape);
      if (!entry) return placeholder();
      const factory = (await entry.load()).default;
      return factory(data);
    }
    if (source.kind === "model") {
      let request = this.models.get(source.url);
      if (!request) { request = this.loader.loadAsync(source.url); this.models.set(source.url, request); }
      const gltf = await request;
      // Skinned characters and animals need their skeletons cloned with them.
      const content = cloneSkinned(gltf.scene);
      content.userData.clips = gltf.animations;
      return content;
    }
    const texture = await this.textures.loadAsync(source.url);
    texture.colorSpace = THREE.SRGBColorSpace;
    const image = texture.image as { width: number; height: number };
    const aspect = image.height / Math.max(1, image.width);
    const width = 1;
    return new THREE.Mesh(
      new THREE.PlaneGeometry(width, width * aspect).translate(0, width * aspect / 2, 0),
      new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, toneMapped: false })
    );
  }

  /** Start the object's chosen clip: the one it names, else one called idle, else the first. */
  private play(record: ObjectRecord) {
    record.mixer?.stopAllAction();
    record.mixer = null;
    record.clip = record.data.animation ?? "";
    const clips = (record.content?.userData.clips ?? []) as THREE.AnimationClip[];
    if (!record.content || !clips.length) return;
    const clip = clips.find((item) => item.name === record.data.animation)
      ?? clips.find((item) => /idle/i.test(item.name)) ?? clips[0];
    record.mixer = new THREE.AnimationMixer(record.content);
    const action = record.mixer.clipAction(clip);
    action.play();
    // Several copies of one model should not move in step.
    action.time = record.phase / (Math.PI * 2) * clip.duration;
  }

  private disposeContent(record: ObjectRecord) {
    record.mixer?.stopAllAction();
    record.mixer = null;
    if (!record.content) return;
    record.motion.remove(record.content);
    // Models are shared clones: only dispose geometry that this object owns.
    if (record.data.source.kind !== "model") disposeTree(record.content);
    record.content = null;
  }
}

function easeOutBack(value: number) {
  const c1 = 1.4;
  const c3 = c1 + 1;
  return value <= 0 ? 0 : value >= 1 ? 1 : 1 + c3 * Math.pow(value - 1, 3) + c1 * Math.pow(value - 1, 2);
}

function placeholder() {
  return new THREE.Mesh(
    new THREE.OctahedronGeometry(0.15).translate(0, 0.15, 0),
    new THREE.MeshStandardMaterial({ color: 0xbbbbbb, wireframe: true })
  );
}

/** Draw after the capture occluder (render order 30) in the transparent pass. */
function prepareForOcclusion(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh && !(child as THREE.Sprite).isSprite) return;
    child.renderOrder = Math.max(child.renderOrder, 35);
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!material) continue;
      material.transparent = true;
      if (material.blending === THREE.NormalBlending) material.depthWrite = true;
    }
  });
}

function disposeTree(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of materials) {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose();
      material.dispose();
    }
  });
}
