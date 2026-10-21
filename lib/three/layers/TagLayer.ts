import * as THREE from "three";
import { defaultTagColor, type SpaceTag } from "@/lib/space-tags";

/** How far a disc stands off its surface along the tag's stem, in meters. */
const STEM = 0.3;
/** A disc's size on screen in CSS pixels, at any distance; the hovered and selected ones grow. */
const DISC_PX = 26;
const HOVERED = 1.18;
const SELECTED = 1.32;
/** Until the capture mesh can hide tags behind walls, only those this close to the visitor show, in meters. */
const BESIDE = 4;

type TagRecord = {
  tag: SpaceTag;
  disc: THREE.Sprite;
  stem: THREE.Line | null;
  /** Where the disc is in the world: off the surface along the stem, or on the point without one. */
  head: THREE.Vector3;
};

/** What the layer needs from the view each frame; tags are `hidden` in a headset and in a frame for a thumbnail. */
export type TagView = { node: string | null; orbit: boolean; hidden: boolean };

/**
 * Tags drawn like Mattertags: a disc in the tag's color on a short white stem from the surface
 * it stands on. Discs keep their size on screen at any distance and draw after the capture's
 * depth occluder (render order 30), so walls hide the tags behind them. A tag placed in a
 * panorama with nothing to stand on shows only from that panorama, over the view.
 */
export class TagLayer {
  readonly group = new THREE.Group();
  private readonly records = new Map<string, TagRecord>();
  private readonly textures = new Map<string, THREE.Texture>();
  private readonly stemMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false, fog: false });
  private readonly toCamera = new THREE.Vector3();
  private hovered: string | null = null;
  private selected: string | null = null;
  private shown = true;
  private ready = true;

  constructor(private readonly scene: THREE.Scene) {
    this.group.name = "tags";
    this.scene.add(this.group);
  }

  get count() { return this.records.size; }

  get(id: string) { return this.records.get(id)?.tag ?? null; }

  /** Where a tag's disc is in the world. */
  head(id: string) { return this.records.get(id)?.head.clone() ?? null; }

  setTags(tags: SpaceTag[]) {
    for (const record of this.records.values()) this.remove(record);
    this.records.clear();
    for (const tag of tags) {
      const anchor = new THREE.Vector3(tag.position.x, tag.position.y, tag.position.z);
      const head = tag.normal && !tag.nodeId ? anchor.clone().addScaledVector(new THREE.Vector3(tag.normal.x, tag.normal.y, tag.normal.z), STEM) : anchor.clone();
      const disc = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.texture(tag.color ?? defaultTagColor), sizeAttenuation: false, transparent: true, depthWrite: false,
        // In a panorama with nothing to stand on, nothing can hide it either.
        depthTest: !tag.nodeId, toneMapped: false, fog: false
      }));
      disc.position.copy(head);
      disc.renderOrder = 41;
      disc.userData.tagId = tag.id;
      this.group.add(disc);
      let stem: THREE.Line | null = null;
      if (head.distanceToSquared(anchor) > 0) {
        stem = new THREE.Line(new THREE.BufferGeometry().setFromPoints([anchor, head]), this.stemMaterial);
        stem.renderOrder = 40;
        this.group.add(stem);
      }
      this.records.set(tag.id, { tag, disc, stem, head });
    }
    if (this.hovered && !this.records.has(this.hovered)) this.hovered = null;
    if (this.selected && !this.records.has(this.selected)) this.selected = null;
  }

  setHovered(id: string | null) { this.hovered = id; }

  setSelected(id: string | null) { this.selected = id && this.records.has(id) ? id : null; }

  /** The visitor's choice to see tags or not. */
  setShown(shown: boolean) { this.shown = shown; }

  /** Until the capture mesh that hides tags behind walls has arrived, only the tags beside the visitor show. */
  setReady(ready: boolean) { this.ready = ready; }

  /** The disc under the raycaster's ray (its camera set), nearest first. */
  pick(raycaster: THREE.Raycaster) {
    if (!this.group.visible) return null;
    const discs = [...this.records.values()].filter(record => record.disc.visible).map(record => record.disc);
    const hit = raycaster.intersectObjects(discs, false)[0];
    return hit ? { id: hit.object.userData.tagId as string, distance: hit.distance, overView: !(hit.object as THREE.Sprite).material.depthTest } : null;
  }

  update(camera: THREE.PerspectiveCamera, viewportHeight: number, view: TagView) {
    this.group.visible = this.shown && !view.hidden && this.records.size > 0 && viewportHeight > 0;
    if (!this.group.visible) return;
    const perPixel = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / viewportHeight;
    for (const [id, record] of this.records) {
      const visible = record.tag.nodeId ? !view.orbit && view.node === record.tag.nodeId : this.ready || record.head.distanceTo(camera.position) <= BESIDE;
      record.disc.visible = visible;
      if (record.stem) record.stem.visible = visible;
      if (!visible) continue;
      const size = DISC_PX * (id === this.selected ? SELECTED : id === this.hovered ? HOVERED : 1) * perPixel;
      record.disc.scale.set(size, size, 1);
      // A disc on its point would sink half into the surface that holds it. It moves toward the camera along
      // the line of sight by about its own radius: unseen on screen, it clears the surface for the depth test.
      if (!record.stem) {
        this.toCamera.copy(camera.position).sub(record.head);
        const distance = this.toCamera.length();
        record.disc.position.copy(record.head).addScaledVector(this.toCamera.normalize(), Math.min(distance * 0.5, size * distance * 0.6));
      }
    }
  }

  dispose() {
    for (const record of this.records.values()) this.remove(record);
    this.records.clear();
    this.textures.forEach(texture => texture.dispose());
    this.textures.clear();
    this.stemMaterial.dispose();
    this.scene.remove(this.group);
  }

  private remove(record: TagRecord) {
    this.group.remove(record.disc);
    record.disc.material.dispose();
    if (record.stem) { this.group.remove(record.stem); record.stem.geometry.dispose(); }
  }

  /** A disc in a color: the color ringed in white, with a dark edge so it reads on bright photos too. */
  private texture(color: string) {
    const known = this.textures.get(color);
    if (known) return known;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 96;
    const context = canvas.getContext("2d");
    const circle = (radius: number, fill: string) => {
      if (!context) return;
      context.beginPath();
      context.arc(48, 48, radius, 0, Math.PI * 2);
      context.fillStyle = fill;
      context.fill();
    };
    circle(46, "rgba(0, 0, 0, 0.4)");
    circle(42, "#ffffff");
    circle(32, "rgba(0, 0, 0, 0.25)");
    circle(31, color);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.textures.set(color, texture);
    return texture;
  }
}
