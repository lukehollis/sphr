import * as THREE from "three";
import { soundEntry } from "@/lib/experience/packs";
import type { AudioHost } from "@/lib/experience/registry";

/**
 * One audio graph for a space's effects: a listener riding on the camera, so
 * positional sounds pan and fade as visitors look and walk, and a master gain
 * that follows the viewer's mute button. Browsers keep audio silent until the
 * visitor first touches or presses a key; the context resumes then.
 */
export class ExperienceAudio implements AudioHost {
  readonly listener: THREE.AudioListener;
  readonly context: AudioContext;
  private readonly cache = new Map<string, Promise<AudioBuffer | null>>();
  private muted = false;
  private readonly unlock = () => { void this.context.resume().catch(() => {}); };

  constructor(camera: THREE.Camera) {
    this.listener = new THREE.AudioListener();
    camera.add(this.listener);
    this.context = this.listener.context;
    for (const type of ["pointerdown", "keydown", "touchend"]) window.addEventListener(type, this.unlock, { passive: true });
    this.unlock();
  }

  unlocked() {
    return this.context.state === "running";
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.listener.setMasterVolume(muted ? 0 : 1);
  }

  isMuted() {
    return this.muted;
  }

  buffer(source: string) {
    let request = this.cache.get(source);
    if (!request) {
      request = this.load(source).catch((error) => {
        console.warn(`Unable to load sound ${source}`, error);
        return null;
      });
      this.cache.set(source, request);
    }
    return request;
  }

  /** Play a sound once, unpositioned, for previews in the editor. */
  async preview(source: string, volume = 0.8) {
    await this.context.resume().catch(() => {});
    const buffer = await this.buffer(source);
    if (!buffer) return false;
    const node = this.context.createBufferSource();
    const gain = this.context.createGain();
    gain.gain.value = volume;
    node.buffer = buffer;
    node.connect(gain).connect(this.listener.getInput());
    node.start();
    if (buffer.duration > 12) node.stop(this.context.currentTime + 12);
    return true;
  }

  dispose() {
    for (const type of ["pointerdown", "keydown", "touchend"]) window.removeEventListener(type, this.unlock);
    this.listener.parent?.remove(this.listener);
    this.cache.clear();
  }

  private async load(source: string): Promise<AudioBuffer | null> {
    const entry = soundEntry(source);
    if (entry) {
      const render = (await entry.load()).default;
      return render(this.context.sampleRate);
    }
    if (!/^https:\/\//.test(source) && !/^\/(?!\/)/.test(source)) return null;
    const response = await fetch(source);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return this.context.decodeAudioData(await response.arrayBuffer());
  }
}
