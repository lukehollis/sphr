import * as THREE from "three";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";
import { XRHandModelFactory } from "three/examples/jsm/webxr/XRHandModelFactory.js";
import type { XrPanel } from "@/lib/types";
import { TourPanel } from "@/lib/three/xr/TourPanel";

/** What a pointer ray would act on: where it meets the space, and whether a press there does anything. */
export type XrHover = { point: THREE.Vector3; normal?: THREE.Vector3; distance: number; active: boolean };

/** What the viewer does for the headset; the rig only places the visitor and reads their hands. */
export type ImmersiveHost = {
  /** Where the viewer's camera stands: the visitor's eyes are placed there. */
  eye(): THREE.Vector3;
  /** The camera is flying to another view; the headset darkens until it lands. */
  flying(): boolean;
  /** Once a move lands, the way the visitor should face (a guided stop's view), taken once. */
  takeFacing(): THREE.Vector3 | null;
  /** The visitor's head turned: the viewer's camera looks the same way. */
  look(quaternion: THREE.Quaternion): void;
  /** Spaces without panorama locations walk with the stick instead of stepping between them. */
  walksFreely(): boolean;
  hover(ray: THREE.Ray, primary: boolean): XrHover | null;
  select(ray: THREE.Ray): void;
  /** Stick forward or back where the space has panorama locations: to the next one that way. */
  step(direction: 1 | -1): void;
  /** Stick held in a space walked freely, -1..1 forward and right. */
  walk(forward: number, right: number): void;
  /** A panel button, or a controller's face buttons standing in for Next and Previous. */
  action(id: string): void;
  ended(): void;
};

const SNAP_TURN = THREE.MathUtils.degToRad(30);
const FADE_OUT_S = 0.12;
const FADE_IN_S = 0.22;
/** A jump this far between frames, without a flight or the stick, still darkens the headset. */
const JUMP = 0.6;
/**
 * The panel hangs this far ahead, its top edge this far below the eyes and its middle this
 * far to the left, like the tour's text box at the bottom left of the screen: what a stop
 * looks at stays clear in the middle of the view.
 */
const PANEL_DISTANCE = 1.35;
const PANEL_DROP = THREE.MathUtils.degToRad(14);
const PANEL_SIDE = THREE.MathUtils.degToRad(20);
/** Turned this far from the panel for this long, it comes around to where the visitor looks. */
const PANEL_FOLLOW_ANGLE = THREE.MathUtils.degToRad(65);
const PANEL_FOLLOW_S = 1.4;
const SCROLL_SPEED = 900;
const LASER_LENGTH = 6;
const DEAD_ZONE = 0.15;
const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, -1);

type Hand = {
  index: number;
  ray: THREE.Group;
  laser: THREE.Line;
  reticle: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  source: XRInputSource | null;
  /** Edge state for the stick and face buttons. */
  turnArmed: boolean;
  stepArmed: boolean;
  pressed: boolean[];
};

/**
 * idle: the eyes follow the camera. out: a move began, the eyes hold while the headset darkens.
 * dark: the eyes follow the camera unseen until the move lands.
 */
type Blink = "idle" | "out" | "dark";

/** Heading of a direction about the vertical, three.js style: 0 looks down -Z. */
export function yawOf(direction: THREE.Vector3) {
  return Math.atan2(-direction.x, -direction.z);
}

function wrapAngle(radians: number) {
  return Math.atan2(Math.sin(radians), Math.cos(radians));
}

/**
 * The visitor in a VR headset. The viewer keeps flying its own camera between views as it
 * does on screen; this rig carries the headset to that camera's place, turned so the head's
 * own turning looks around. Moves are hidden behind a quick fade to black (no gliding in a
 * headset), and each lands with the eyes at the panorama's centre, facing a guided stop's view.
 */
export class ImmersiveRig {
  readonly rig = new THREE.Group();
  /** Renders the headset's views; three.js sets its pose from the headset each frame. */
  readonly camera = new THREE.PerspectiveCamera(80, 1, 0.05, 20000);
  readonly panel: TourPanel;
  private readonly fade: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private readonly hands: Hand[] = [];
  private session: XRSession | null = null;
  private yaw = 0;
  /** The head's place in the headset's space when the eyes were last put at the camera. */
  private readonly anchor = new THREE.Vector3();
  /** Where the rig has placed the eyes: the camera's place, except while a move is hidden. */
  private readonly placed = new THREE.Vector3();
  private fadeAmount = 0;
  private blink: Blink = "idle";
  private reanchor = true;
  private started = false;
  /** The stick walks the space until this time (its easing out is not a jump). */
  private walkingUntil = 0;
  /** Dark until the headset is handed to the next space's viewer, and who waits for the dark. */
  private holdDark = false;
  private darkWaiters: (() => void)[] = [];
  private primary = 1;
  private panelYaw = 0;
  private panelAway = 0;
  private panelGlide: { from: number; to: number; t: number } | null = null;
  private frame = 0;
  private readonly headLocal = new THREE.Vector3();
  private readonly headQuaternion = new THREE.Quaternion();
  private readonly world = new THREE.Quaternion();
  private readonly ray = new THREE.Ray();
  private readonly onSessionEnd = () => this.end();
  private readonly onReset = () => { this.reanchor = true; };

  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly scene: THREE.Scene, private readonly host: ImmersiveHost) {
    this.rig.name = "xr-rig";
    this.rig.add(this.camera);
    this.panel = new TourPanel(renderer.capabilities.getMaxAnisotropy());
    this.rig.add(this.panel.mesh);
    // Drawn last over everything, so it darkens the whole view whatever its size.
    const fade = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, side: THREE.BackSide, depthTest: false, depthWrite: false, toneMapped: false }));
    fade.renderOrder = 10000;
    fade.frustumCulled = false;
    fade.visible = false;
    this.fade = fade;
    this.camera.add(fade);
    // Controllers and hands are drawn from the WebXR input profiles once they connect.
    const controllers = new XRControllerModelFactory();
    const handModels = new XRHandModelFactory();
    for (let index = 0; index < 2; index++) {
      const ray = renderer.xr.getController(index);
      const grip = renderer.xr.getControllerGrip(index);
      const hand = renderer.xr.getHand(index);
      grip.add(controllers.createControllerModel(grip));
      hand.add(handModels.createHandModel(hand, "mesh"));
      const laser = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
        new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthTest: false, depthWrite: false, toneMapped: false })
      );
      laser.renderOrder = 9500;
      laser.frustumCulled = false;
      laser.raycast = () => {};
      laser.visible = false;
      laser.scale.z = LASER_LENGTH;
      ray.add(laser);
      const reticle = new THREE.Mesh(new THREE.RingGeometry(0.62, 1, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
      reticle.renderOrder = 9600;
      reticle.frustumCulled = false;
      reticle.visible = false;
      reticle.raycast = () => {};
      this.rig.add(reticle);
      const entry: Hand = { index, ray, laser, reticle, source: null, turnArmed: true, stepArmed: true, pressed: [] };
      ray.addEventListener("connected", (event) => {
        const source = (event as unknown as { data: XRInputSource }).data;
        entry.source = source;
        // Pointing from the eyes (Vision Pro's look and pinch, a phone's gaze) shows no beam.
        laser.visible = source.targetRayMode === "tracked-pointer";
      });
      ray.addEventListener("disconnected", () => { entry.source = null; laser.visible = false; reticle.visible = false; });
      ray.addEventListener("select", () => this.select(entry));
      this.rig.add(ray, grip, hand);
      this.hands.push(entry);
    }
  }

  get presenting() { return Boolean(this.session); }

  getDebugSnapshot() {
    const panel = this.panel.content;
    return {
      presenting: this.presenting,
      blink: this.blink,
      fade: Number(this.fadeAmount.toFixed(3)),
      yaw: Number(THREE.MathUtils.radToDeg(this.yaw).toFixed(1)),
      headYaw: Number(THREE.MathUtils.radToDeg(this.headYaw()).toFixed(1)),
      eye: this.rig.localToWorld(this.headLocal.clone()).toArray().map((value) => Number(value.toFixed(3))),
      hands: this.hands.map((hand) => ({ connected: Boolean(hand.source), mode: hand.source?.targetRayMode ?? null, reticle: hand.reticle.visible })),
      panel: panel ? { visible: this.panel.visible, eyebrow: panel.eyebrow ?? null, title: panel.title ?? null, buttons: panel.buttons.map((button) => `${button.id}${button.enabled === false ? "(off)" : ""}`) } : null
    };
  }

  /** Show the space in the headset. `yaw` carries the turn over from a previous space's rig. */
  async start(session: XRSession, yaw?: number) {
    this.session = session;
    this.started = false;
    this.reanchor = true;
    if (yaw !== undefined) this.yaw = yaw;
    this.fadeAmount = yaw === undefined ? 0 : 1;
    this.blink = yaw === undefined ? "idle" : "dark";
    this.scene.add(this.rig);
    this.renderer.xr.enabled = true;
    // The headset's own space starts at the head; the eyes are put at the camera from there.
    this.renderer.xr.setReferenceSpaceType("local");
    this.renderer.xr.setFoveation(0.5);
    session.addEventListener("end", this.onSessionEnd);
    try { await this.renderer.xr.setSession(session); }
    catch (error) {
      session.removeEventListener("end", this.onSessionEnd);
      this.session = null;
      this.scene.remove(this.rig);
      this.renderer.xr.enabled = false;
      throw error;
    }
    this.renderer.xr.getReferenceSpace()?.addEventListener("reset", this.onReset);
    // A session taken over from another space's viewer already has its hands; three.js hears of
    // input sources only as they connect, so it is told about the ones already there.
    if (yaw !== undefined && session.inputSources.length) {
      session.dispatchEvent(Object.assign(new Event("inputsourceschange"), { added: Array.from(session.inputSources), removed: [] }));
    }
  }

  /** Darken the headset, before handing it to the next space's viewer; resolves once dark. */
  darken() {
    if (!this.session || this.fadeAmount >= 0.98) return Promise.resolve();
    this.holdDark = true;
    // A headset that stops drawing (taken off, its browser paused) does not hold the tour up.
    return new Promise<void>((resolve) => { this.darkWaiters.push(resolve); setTimeout(resolve, 600); });
  }

  /** Let another rig take the headset (the tour went on to another space); returns the session and turn. */
  release() {
    this.holdDark = false;
    for (const resolve of this.darkWaiters.splice(0)) resolve();
    const session = this.session;
    if (!session) return null;
    session.removeEventListener("end", this.onSessionEnd);
    this.renderer.xr.getReferenceSpace()?.removeEventListener("reset", this.onReset);
    this.session = null;
    this.scene.remove(this.rig);
    // three.js lets go of a session only when it ends: an "end" heard before the next viewer
    // listens stops this renderer drawing to the headset while the session goes on.
    session.dispatchEvent(new Event("end"));
    this.renderer.xr.enabled = false;
    return { session, yaw: this.yaw };
  }

  stop() {
    void this.session?.end().catch(() => {});
  }

  setPanel(panel: XrPanel | null) {
    const changed = this.panel.set(panel);
    // New text comes up in front of the visitor.
    if (changed && panel && this.started) { this.panelYaw = this.headYaw(); this.panelGlide = null; this.placePanel(); }
  }

  private end() {
    this.holdDark = false;
    for (const resolve of this.darkWaiters.splice(0)) resolve();
    this.renderer.xr.getReferenceSpace()?.removeEventListener("reset", this.onReset);
    this.session = null;
    this.scene.remove(this.rig);
    this.renderer.xr.enabled = false;
    for (const hand of this.hands) { hand.source = null; hand.reticle.visible = false; hand.laser.visible = false; }
    this.host.ended();
  }

  /** Before the viewer's frame: read the head and the hands, and steer the camera with them. */
  update(elapsed: number, now: number) {
    if (!this.session) return;
    this.frame += 1;
    this.renderer.xr.updateCamera(this.camera);
    this.headLocal.copy(this.camera.position);
    this.headQuaternion.copy(this.camera.quaternion);
    const eye = this.host.eye();
    if (!this.started) {
      this.started = true;
      this.placed.copy(eye);
      this.anchor.copy(this.headLocal);
      this.reanchor = false;
      // Facing the way the screen looked, so the headset opens on the same view.
      const facing = this.host.takeFacing();
      if (facing) this.face(facing);
      this.panelYaw = this.headYaw();
      this.placePanel();
    }
    if (this.reanchor) { this.reanchor = false; this.anchor.copy(this.headLocal); this.placed.copy(eye); }

    // A flight, or a jump, darkens the headset; the eyes follow the camera only once it is dark.
    const hide = this.hiding(eye, now);
    if (this.blink === "idle" && hide) this.blink = "out";
    if (this.blink === "out" && this.fadeAmount >= 0.98) this.blink = "dark";
    if (this.blink === "dark" && !hide) {
      // Landed in the dark: eyes at the panorama's centre, facing what the stop is about.
      this.blink = "idle";
      this.placed.copy(eye);
      this.anchor.copy(this.headLocal);
      const facing = this.host.takeFacing();
      if (facing) this.face(facing);
      this.panelYaw = this.headYaw();
      this.panelGlide = null;
      this.placePanel();
    }
    const target = this.blink === "idle" ? 0 : 1;
    const rate = elapsed / (target > this.fadeAmount ? FADE_OUT_S : FADE_IN_S);
    this.fadeAmount = THREE.MathUtils.clamp(this.fadeAmount + Math.sign(target - this.fadeAmount) * rate, 0, 1);
    if (this.fadeAmount >= 0.98 && this.darkWaiters.length) for (const resolve of this.darkWaiters.splice(0)) resolve();
    this.fade.material.opacity = this.fadeAmount;
    this.fade.visible = this.fadeAmount > 0.001;

    // The viewer's camera turns with the head, so what it works out from its view (the way
    // ahead, sound, what is in sight) follows the visitor; flights keep their own aim.
    if (!this.host.flying()) {
      this.world.setFromAxisAngle(UP, this.yaw).multiply(this.headQuaternion);
      this.host.look(this.world);
    }

    this.pollInput(elapsed, now);
    this.updatePanel(elapsed);
  }

  /** After the viewer's frame, just before drawing: put the eyes where its camera now is. */
  place(now: number) {
    if (!this.session) return;
    const eye = this.host.eye();
    if (this.blink === "dark" || (this.blink === "idle" && !this.hiding(eye, now))) this.placed.copy(eye);
    this.rig.quaternion.setFromAxisAngle(UP, this.yaw);
    this.rig.position.copy(this.anchor).applyQuaternion(this.rig.quaternion).negate().add(this.placed);
    this.rig.updateMatrixWorld(true);
  }

  private hiding(eye: THREE.Vector3, now: number) {
    return this.holdDark || this.host.flying() || (now > this.walkingUntil && eye.distanceTo(this.placed) > JUMP);
  }

  /** Turn the rig so the head, where it looks now, faces a direction in the space. */
  private face(direction: THREE.Vector3) {
    if (Math.hypot(direction.x, direction.z) < 1e-4) return;
    this.turnAroundHead(wrapAngle(yawOf(direction) - this.headYaw()));
  }

  /** Turn the visitor in place, about their head rather than the middle of the play area. */
  private turnAroundHead(radians: number) {
    if (!radians) return;
    const before = new THREE.Quaternion().setFromAxisAngle(UP, this.yaw);
    this.yaw = wrapAngle(this.yaw + radians);
    const after = new THREE.Quaternion().setFromAxisAngle(UP, this.yaw);
    // anchor' = head - after⁻¹·before·(head - anchor): the eyes stay put, only the view turns.
    const offset = this.headLocal.clone().sub(this.anchor).applyQuaternion(before).applyQuaternion(after.invert());
    this.anchor.copy(this.headLocal).sub(offset);
    // The panel turns with the visitor, keeping its place in front of them.
    this.panelYaw = wrapAngle(this.panelYaw + radians);
    this.placePanel();
  }

  private headYaw() {
    return wrapAngle(yawOf(FORWARD.clone().applyQuaternion(this.headQuaternion)) + this.yaw);
  }

  private rayOf(hand: Hand) {
    hand.ray.updateWorldMatrix(true, false);
    this.ray.origin.setFromMatrixPosition(hand.ray.matrixWorld);
    this.ray.direction.copy(FORWARD).transformDirection(hand.ray.matrixWorld);
    return this.ray;
  }

  private select(hand: Hand) {
    if (!this.session || this.blink !== "idle" || this.fadeAmount > 0.5) return;
    this.primary = hand.index;
    const ray = this.rayOf(hand).clone();
    const hit = this.panel.hit(ray);
    if (hit) { if (hit.button) this.host.action(hit.button); return; }
    this.host.select(ray);
  }

  private pollInput(elapsed: number, now: number) {
    let panelButton: string | null = null;
    const free = this.host.walksFreely();
    for (const hand of this.hands) {
      const source = hand.source;
      if (!source) { hand.reticle.visible = false; continue; }
      const ray = this.rayOf(hand);
      const hit = this.panel.hit(ray);
      if (hit) {
        if (hand.index === this.primary || !panelButton) panelButton = hit.button;
        this.showReticle(hand, hit.point, null, hit.distance, Boolean(hit.button));
      } else if ((this.frame + hand.index) % 2 === 0) {
        // Each hand tests the space every other frame; the panel every frame.
        const hover = this.blink !== "idle" ? null : this.host.hover(ray, hand.index === this.primary);
        if (hover) this.showReticle(hand, hover.point, hover.normal ?? null, hover.distance, hover.active);
        else { hand.reticle.visible = false; hand.laser.scale.z = LASER_LENGTH; }
      }
      const gamepad = source.gamepad;
      if (!gamepad) continue;
      // xr-standard puts the thumbstick on axes 2 and 3; a touchpad uses 0 and 1.
      const x = (gamepad.axes.length >= 4 ? gamepad.axes[2] : gamepad.axes[0]) ?? 0;
      const y = (gamepad.axes.length >= 4 ? gamepad.axes[3] : gamepad.axes[1]) ?? 0;
      if (Math.abs(x) > 0.2 || Math.abs(y) > 0.2 || gamepad.buttons[0]?.pressed) this.primary = hand.index;
      // In a space walked freely the left stick walks and strafes; any other stick turns and steps.
      const strafes = free && source.handedness === "left";
      if (hit && this.panel.scrollable && Math.abs(y) > DEAD_ZONE) this.panel.scrollBy(y * SCROLL_SPEED * elapsed);
      else if (free) {
        const forward = Math.abs(y) > DEAD_ZONE ? -y : 0;
        const right = strafes && Math.abs(x) > DEAD_ZONE ? x : 0;
        if (forward || right) { this.walkingUntil = now + 600; this.host.walk(forward, right); }
      } else {
        if (hand.stepArmed && Math.abs(y) > 0.7 && this.blink === "idle") { hand.stepArmed = false; this.host.step(y < 0 ? 1 : -1); }
        if (Math.abs(y) < 0.3) hand.stepArmed = true;
      }
      if (!strafes) {
        if (hand.turnArmed && Math.abs(x) > 0.65) { hand.turnArmed = false; this.turnAroundHead(x > 0 ? -SNAP_TURN : SNAP_TURN); }
        if (Math.abs(x) < 0.3) hand.turnArmed = true;
      }
      // A and X stand in for the panel's main button (Next), B and Y for Previous.
      for (const [button, action] of [[4, "primary"], [5, "previous"]] as const) {
        const down = Boolean(gamepad.buttons[button]?.pressed);
        if (down && !hand.pressed[button] && this.blink === "idle") this.pressPanel(action);
        hand.pressed[button] = down;
      }
    }
    this.panel.setHovered(panelButton);
    if (!this.hands.some((hand) => hand.source && hand.index === this.primary)) {
      const other = this.hands.find((hand) => hand.source);
      if (other) this.primary = other.index;
    }
  }

  private pressPanel(action: "primary" | "previous") {
    const buttons = this.panel.visible ? this.panel.content?.buttons ?? [] : [];
    const button = action === "primary" ? buttons.find((item) => item.primary) : buttons.find((item) => item.id === "previous");
    if (button && button.enabled !== false) this.host.action(button.id);
  }

  private showReticle(hand: Hand, point: THREE.Vector3, normal: THREE.Vector3 | null, distance: number, active: boolean) {
    const reticle = hand.reticle;
    hand.laser.scale.z = Math.max(0.05, distance);
    // About the same size in view at any distance, lying on what it points at.
    const facing = (normal ? normal.clone() : this.ray.direction.clone().negate()).applyQuaternion(this.rig.quaternion.clone().invert()).normalize();
    reticle.position.copy(point);
    this.rig.worldToLocal(reticle.position);
    reticle.position.addScaledVector(facing, 0.004);
    reticle.scale.setScalar(THREE.MathUtils.clamp(distance * 0.011, 0.005, 0.5) * (active ? 1.5 : 1));
    reticle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), facing);
    reticle.material.color.set(active ? 0xffffff : 0xb8c0c8);
    reticle.material.opacity = active ? 0.95 : 0.55;
    reticle.visible = true;
  }

  /** The panel stays where it was put while the visitor looks around, and comes around when they turn away. */
  private updatePanel(elapsed: number) {
    if (!this.panel.visible) { this.panel.update(); return; }
    const away = Math.abs(wrapAngle(this.headYaw() - this.panelYaw));
    this.panelAway = away > PANEL_FOLLOW_ANGLE ? this.panelAway + elapsed : 0;
    if (this.panelAway > PANEL_FOLLOW_S && !this.panelGlide) this.panelGlide = { from: this.panelYaw, to: this.headYaw(), t: 0 };
    if (this.panelGlide) {
      const glide = this.panelGlide;
      glide.t = Math.min(1, glide.t + elapsed / 0.45);
      const ease = glide.t * glide.t * (3 - 2 * glide.t);
      this.panelYaw = wrapAngle(glide.from + wrapAngle(glide.to - glide.from) * ease);
      this.placePanel();
      if (glide.t >= 1) { this.panelGlide = null; this.panelAway = 0; }
    }
    this.panel.update();
  }

  /** Ahead of the head at the panel's heading, a little below the eyes and to the left, facing them. */
  private placePanel() {
    const mesh = this.panel.mesh;
    const local = this.panelYaw + PANEL_SIDE - this.yaw;
    const ahead = new THREE.Vector3(-Math.sin(local), 0, -Math.cos(local));
    mesh.position.copy(this.headLocal)
      .addScaledVector(ahead, PANEL_DISTANCE * Math.cos(PANEL_DROP))
      .addScaledVector(UP, -PANEL_DISTANCE * Math.sin(PANEL_DROP));
    // Tipped back a little, like a lectern.
    mesh.quaternion.setFromEuler(new THREE.Euler(-PANEL_DROP * 1.6, local, 0, "YXZ"));
  }

  dispose() {
    this.release();
    this.scene.remove(this.rig);
    this.panel.dispose();
    this.fade.geometry.dispose();
    this.fade.material.dispose();
    for (const hand of this.hands) {
      hand.laser.geometry.dispose();
      (hand.laser.material as THREE.Material).dispose();
      hand.reticle.geometry.dispose();
      hand.reticle.material.dispose();
    }
  }
}
