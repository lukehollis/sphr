export type Tween = {
  update: (now: number) => boolean;
  cancel: () => void;
};

export function createTween(options: {
  duration: number;
  onUpdate: (value: number) => void;
  onComplete?: () => void;
  easing?: (value: number) => number;
}): Tween {
  const start = performance.now();
  let cancelled = false;
  const easing = options.easing ?? easeInOutCubic;

  return {
    update(now: number) {
      if (cancelled) return false;
      const raw = Math.min(1, (now - start) / Math.max(1, options.duration));
      options.onUpdate(easing(raw));
      if (raw >= 1) {
        options.onComplete?.();
        return false;
      }
      return true;
    },
    cancel() {
      cancelled = true;
    }
  };
}

export function easeInOutCubic(value: number) {
  return value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2;
}
