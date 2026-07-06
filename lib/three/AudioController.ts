import type { AudioConfig, TourPoint } from "@/lib/types";

type ManagedAudio = {
  config: AudioConfig;
  element: HTMLAudioElement;
};

export class AudioController {
  private readonly sounds = new Map<string, ManagedAudio>();
  private muted = false;

  constructor(configs: Record<string, AudioConfig>) {
    Object.entries(configs).forEach(([id, config]) => {
      const element = new Audio(config.url);
      element.loop = config.options?.loop ?? false;
      element.volume = config.options?.volume ?? 0.15;
      element.preload = "auto";
      this.sounds.set(id, { config, element });
    });
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.sounds.forEach(({ element }) => {
      element.muted = muted;
    });
  }

  play(id: string) {
    const sound = this.sounds.get(id);
    if (!sound) return;
    sound.element.muted = this.muted;
    void sound.element.play().catch(() => {
      // Browsers can reject autoplay until the first user gesture.
    });
  }

  pause(id: string) {
    this.sounds.get(id)?.element.pause();
  }

  updateForPoint(incoming?: TourPoint, outgoing?: TourPoint) {
    const next = new Set(incoming?.sounds ?? []);
    const previous = new Set(outgoing?.sounds ?? []);

    previous.forEach((id) => {
      if (!next.has(id)) this.fade(id, 0, 500, true);
    });
    next.forEach((id) => {
      const sound = this.sounds.get(id);
      if (!sound) return;
      if (sound.element.paused) this.play(id);
      this.fade(id, sound.config.options?.volume ?? 0.15, 500);
    });
  }

  dispose() {
    this.sounds.forEach(({ element }) => {
      element.pause();
      element.src = "";
    });
    this.sounds.clear();
  }

  private fade(id: string, targetVolume: number, duration: number, pauseAtEnd = false) {
    const sound = this.sounds.get(id);
    if (!sound) return;
    const startVolume = sound.element.volume;
    const start = performance.now();

    const tick = () => {
      const value = Math.min(1, (performance.now() - start) / duration);
      sound.element.volume = startVolume + (targetVolume - startVolume) * value;
      if (value < 1) {
        requestAnimationFrame(tick);
      } else if (pauseAtEnd) {
        sound.element.pause();
      }
    };

    requestAnimationFrame(tick);
  }
}
