import * as THREE from "three";
import type { XrPanel } from "@/lib/types";

/** Canvas pixels across the panel; a pixel is about a millimeter at the panel's width. */
const WIDTH = 1024;
/** The canvas is square; the panel uses as much of its height as the text needs. */
const SIZE = 1024;
const METERS = 0.92;
const PAD = 44;
const MAX_HEIGHT = 720;
const BUTTON_HEIGHT = 76;
const GAP = 2;
const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const ACCENT = "#0098db";

type Line = { text: string; font: string; color: string; height: number; rule?: boolean };
type ButtonBox = { id: string; enabled: boolean; x: number; y: number; w: number; h: number };
/** Where a ray meets the panel: the button under it (when it can be pressed) and how far away. */
export type PanelHit = { button: string | null; distance: number; point: THREE.Vector3 };

/**
 * A guided tour's text and buttons in a VR headset, drawn into a canvas on a square
 * dark panel that hangs from its top edge, the way the tour box sits on screen.
 * Long text scrolls under the buttons, which stay at the bottom.
 */
export class TourPanel {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly canvas = document.createElement("canvas");
  private readonly context: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private panel: XrPanel | null = null;
  private key = "";
  private height = 0;
  private buttons: ButtonBox[] = [];
  private hovered: string | null = null;
  private scroll = 0;
  private maxScroll = 0;
  private dirty = false;
  private readonly raycaster = new THREE.Raycaster();

  constructor(anisotropy = 1) {
    this.canvas.width = WIDTH;
    this.canvas.height = SIZE;
    this.context = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = anisotropy;
    // The panel hangs from its top edge, so it can grow down as the text needs.
    const geometry = new THREE.PlaneGeometry(1, 1).translate(0, -0.5, 0);
    const material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = "xr-tour-panel";
    this.mesh.renderOrder = 9000;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
  }

  get visible() { return this.mesh.visible; }
  get scrollable() { return this.maxScroll > 0; }
  get content() { return this.panel; }

  /** New content; a different stop starts at the top of its text. Returns whether the content changed. */
  set(panel: XrPanel | null) {
    const key = JSON.stringify(panel);
    if (key === this.key) return false;
    const textKey = panel ? JSON.stringify([panel.eyebrow, panel.title, panel.paragraphs]) : "";
    if (!this.panel || textKey !== JSON.stringify([this.panel.eyebrow, this.panel.title, this.panel.paragraphs])) this.scroll = 0;
    this.key = key;
    this.panel = panel;
    this.mesh.visible = Boolean(panel);
    this.dirty = true;
    return true;
  }

  setHovered(id: string | null) {
    if (id === this.hovered) return;
    this.hovered = id;
    this.dirty = true;
  }

  /** Scroll the text by a number of canvas pixels (down is positive). */
  scrollBy(pixels: number) {
    const next = THREE.MathUtils.clamp(this.scroll + pixels, 0, this.maxScroll);
    if (Math.abs(next - this.scroll) < 0.5) return;
    this.scroll = next;
    this.dirty = true;
  }

  /** The button a ray points at, or null for the panel's text; undefined when the ray misses. */
  hit(ray: THREE.Ray): PanelHit | undefined {
    if (!this.mesh.visible || !this.height) return undefined;
    this.raycaster.ray.copy(ray);
    const hit = this.raycaster.intersectObject(this.mesh, false)[0];
    if (!hit?.uv) return undefined;
    const x = hit.uv.x * WIDTH;
    // The geometry's top edge is v = 1 and the mesh is scaled to the drawn height.
    const y = (1 - hit.uv.y) * this.height;
    const button = this.buttons.find((box) => box.enabled && x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h);
    return { button: button?.id ?? null, distance: hit.distance, point: hit.point.clone() };
  }

  update() {
    if (!this.dirty) return;
    this.dirty = false;
    this.draw();
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
  }

  private draw() {
    const context = this.context;
    const panel = this.panel;
    context.clearRect(0, 0, WIDTH, SIZE);
    if (!panel) { this.height = 0; this.texture.needsUpdate = true; return; }
    const inner = WIDTH - PAD * 2;
    const lines: Line[] = [];
    const add = (text: string, font: string, color: string, lineHeight: number, rule?: boolean) => {
      context.font = font;
      for (const line of wrap(context, text, rule ? inner - 24 : inner)) lines.push({ text: line, font, color, height: lineHeight, rule });
    };
    const gap = (height: number) => lines.push({ text: "", font: "", color: "", height });
    if (panel.eyebrow) { add(panel.eyebrow.toUpperCase(), `600 22px ${FONT}`, "#a9b0b8", 32); gap(8); }
    if (panel.title) { add(panel.title, `700 40px ${FONT}`, "#ffffff", 50); gap(14); }
    panel.paragraphs.forEach((paragraph, index) => {
      if (index) gap(16);
      add(paragraph, `400 30px ${FONT}`, "#f0f0f0", 42);
    });
    if (panel.note) { gap(20); add(panel.note, `400 28px ${FONT}`, "#ffffff", 40, true); }
    const textHeight = lines.reduce((sum, line) => sum + line.height, 0);
    const buttonsHeight = panel.buttons.length ? BUTTON_HEIGHT + PAD * 0.75 : 0;
    const height = Math.min(MAX_HEIGHT, Math.ceil(PAD + textHeight + PAD * 0.75 + buttonsHeight));
    const textBottom = height - buttonsHeight - (panel.buttons.length ? 0 : PAD * 0.5);
    this.maxScroll = Math.max(0, PAD + textHeight - (textBottom - PAD * 0.5));
    this.scroll = Math.min(this.scroll, this.maxScroll);
    this.height = height;

    // A square, nearly opaque panel, like the tour's text box on screen.
    context.fillStyle = "rgba(0, 0, 0, 0.9)";
    context.fillRect(0, 0, WIDTH, height);

    context.save();
    context.beginPath();
    context.rect(0, 0, WIDTH, textBottom);
    context.clip();
    context.textBaseline = "alphabetic";
    let y = PAD - this.scroll;
    for (const line of lines) {
      if (line.text) {
        context.font = line.font;
        context.fillStyle = line.color;
        context.fillText(line.text, PAD + (line.rule ? 24 : 0), y + line.height * 0.76);
        if (line.rule) { context.fillStyle = ACCENT; context.fillRect(PAD, y, 4, line.height); }
      }
      y += line.height;
    }
    context.restore();
    // More text waits below: the box fades into its buttons and shows which way it scrolls.
    if (this.maxScroll > 0 && this.scroll < this.maxScroll - 1) {
      const fade = context.createLinearGradient(0, textBottom - 70, 0, textBottom);
      fade.addColorStop(0, "rgba(0, 0, 0, 0)");
      fade.addColorStop(1, "rgba(0, 0, 0, 0.9)");
      context.fillStyle = fade;
      context.fillRect(0, textBottom - 70, WIDTH, 70);
      context.strokeStyle = "#ffffff";
      context.lineWidth = 4;
      context.beginPath();
      const cx = WIDTH - PAD - 14, cy = textBottom - 22;
      context.moveTo(cx - 14, cy - 7); context.lineTo(cx, cy + 7); context.lineTo(cx + 14, cy - 7);
      context.stroke();
    }

    this.buttons = layoutButtons(context, panel, height - PAD * 0.75 - BUTTON_HEIGHT);
    for (const box of this.buttons) {
      const button = panel.buttons.find((item) => item.id === box.id)!;
      const hovered = box.enabled && this.hovered === box.id;
      // Next is white with black text; the others are dark. Disabled buttons go grey.
      context.fillStyle = !box.enabled ? (button.primary ? "#3a3d41" : "#1b1d20") : button.primary ? (hovered ? "#dcecf6" : "#ffffff") : hovered ? "#3b4046" : "#26292d";
      context.fillRect(box.x, box.y, box.w, box.h);
      if (hovered) { context.fillStyle = ACCENT; context.fillRect(box.x, box.y + box.h - 5, box.w, 5); }
      context.font = `600 28px ${FONT}`;
      context.fillStyle = !box.enabled ? "#7d828a" : button.primary ? "#000000" : "#ffffff";
      context.textAlign = "center";
      context.fillText(fit(context, button.label, box.w - 24), box.x + box.w / 2, box.y + box.h / 2 + 10);
      context.textAlign = "left";
    }

    this.texture.needsUpdate = true;
    // Only the drawn part of the square canvas shows, at a millimeter a pixel.
    this.texture.repeat.set(1, height / SIZE);
    this.texture.offset.set(0, 1 - height / SIZE);
    this.mesh.scale.set(METERS, (METERS * height) / WIDTH, 1);
  }
}

/** Buttons share one row: secondary ones as wide as their words, the main one takes the rest. */
function layoutButtons(context: CanvasRenderingContext2D, panel: XrPanel, top: number): ButtonBox[] {
  const buttons = panel.buttons;
  if (!buttons.length) return [];
  const inner = WIDTH - PAD * 2 - GAP * (buttons.length - 1);
  context.font = `600 28px ${FONT}`;
  const natural = buttons.map((button) => Math.ceil(context.measureText(button.label).width) + 56);
  const hasPrimary = buttons.some((button) => button.primary);
  let widths: number[];
  if (!hasPrimary) widths = buttons.map(() => inner / buttons.length);
  else {
    const others = buttons.reduce((sum, button, index) => sum + (button.primary ? 0 : Math.min(natural[index], inner * 0.3)), 0);
    widths = buttons.map((button, index) => button.primary ? Math.max(inner * 0.4, inner - others) : Math.min(natural[index], inner * 0.3));
    const total = widths.reduce((sum, width) => sum + width, 0);
    widths = widths.map((width) => (width * inner) / total);
  }
  let x = PAD;
  return buttons.map((button, index) => {
    const box = { id: button.id, enabled: button.enabled !== false, x, y: top, w: widths[index], h: BUTTON_HEIGHT };
    x += widths[index] + GAP;
    return box;
  });
}

/** Words wrapped to a width; a word wider than the line is broken where it must be. */
export function wrap(context: CanvasRenderingContext2D, text: string, width: number) {
  const lines: string[] = [];
  for (const block of text.split("\n")) {
    let line = "";
    for (const word of block.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (context.measureText(candidate).width <= width) { line = candidate; continue; }
      if (line) lines.push(line);
      line = word;
      while (context.measureText(line).width > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && context.measureText(line.slice(0, cut)).width > width) cut -= 1;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  // Blank lines inside a paragraph collapse to one.
  return lines.filter((line, index) => line || (index > 0 && lines[index - 1]));
}

/** A label shortened with an ellipsis to fit its button. */
function fit(context: CanvasRenderingContext2D, text: string, width: number) {
  if (context.measureText(text).width <= width) return text;
  let cut = text.length;
  while (cut > 1 && context.measureText(`${text.slice(0, cut)}…`).width > width) cut -= 1;
  return `${text.slice(0, cut)}…`;
}
