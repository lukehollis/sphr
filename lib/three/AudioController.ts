import type { AudioConfig, TourPoint } from "@/lib/types";

type AutoplayNavigator = Navigator & { getAutoplayPolicy?: (target: HTMLMediaElement) => "allowed" | "allowed-muted" | "disallowed" };

/**
 * Whether the browser says beforehand that it would refuse to play this element until the visitor
 * interacts (Firefox can say so). Asking anyway only earns the refusal, and some extensions wrap
 * play() so that refusal is left unhandled and lands in the error notices.
 */
export function refusesPlayback(element: HTMLMediaElement) {
  try {
    const policy = (navigator as AutoplayNavigator).getAutoplayPolicy?.(element);
    // Firefox answers "allowed-muted" for an element too, its default until the visitor interacts.
    return policy === "disallowed" || (policy === "allowed-muted" && !element.muted);
  } catch { return false; }
}

type ManagedAudio = {
  config: AudioConfig;
  element: HTMLAudioElement;
};

export class AudioController {
  private readonly sounds = new Map<string, ManagedAudio>();
  private muted = false;
  private disposed = false;
  private activePointSounds = new Set<string>();
  private readonly blockedSounds = new Set<string>();

  private retryBlockedPlayback = () => {
    for (const id of this.blockedSounds) {
      this.blockedSounds.delete(id);
      if (this.activePointSounds.has(id)) this.play(id);
    }
  };

  constructor(configs: Record<string, AudioConfig>) {
    // Auto-enter the scene immediately; resume browser-blocked narration on the
    // first normal interaction instead of putting a play gate over the scene.
    window.addEventListener("pointerup", this.retryBlockedPlayback, true);
    window.addEventListener("keydown", this.retryBlockedPlayback, true);
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
    if (!muted) this.retryBlockedPlayback();
  }

  play(id: string) {
    const sound = this.sounds.get(id);
    if (!sound) return;
    sound.element.muted = this.muted;
    if (refusesPlayback(sound.element)) {
      if (!this.disposed && this.activePointSounds.has(id)) this.blockedSounds.add(id);
      return;
    }
    void sound.element.play().catch((error: unknown) => {
      if (!this.disposed && this.activePointSounds.has(id) && error instanceof Error && error.name === "NotAllowedError") this.blockedSounds.add(id);
    });
  }

  pause(id: string) {
    this.blockedSounds.delete(id);
    this.sounds.get(id)?.element.pause();
  }

  updateForPoint(incoming?: TourPoint, outgoing?: TourPoint) {
    const next = new Set(incoming?.sounds ?? []);
    const previous = new Set([...this.activePointSounds, ...(outgoing?.sounds ?? [])]);
    this.activePointSounds = next;
    for (const id of this.blockedSounds) if (!next.has(id)) this.blockedSounds.delete(id);

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
    this.disposed = true;
    window.removeEventListener("pointerup", this.retryBlockedPlayback, true);
    window.removeEventListener("keydown", this.retryBlockedPlayback, true);
    this.blockedSounds.clear();
    this.activePointSounds.clear();
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
      if (this.disposed) return;
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
