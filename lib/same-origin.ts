type OriginGlobal = { from(value: string): { isSameOrigin(other: unknown): boolean } };

type FrameWindow = {
  location: { href: string; assign(url: string): void };
  top?: { location: { href: string } } | null;
  open?: (url?: string, target?: string, features?: string) => unknown;
};

/**
 * Whether `target` resolves to the same origin as `current` (rejecting opaque `"null"` origins,
 * and using the HTML `Origin` API where browsers provide it).
 */
export function isSameOriginUrl(target: string, current: string): boolean {
  let resolved: URL;
  let base: URL;
  try {
    base = new URL(current);
    resolved = new URL(target, base);
  } catch {
    return false;
  }
  const OriginApi = (globalThis as { Origin?: OriginGlobal }).Origin;
  if (OriginApi && typeof OriginApi.from === "function") {
    try {
      return OriginApi.from(resolved.href).isSameOrigin(OriginApi.from(base.href));
    } catch {
      // Fall back to URL origin comparison below.
    }
  }
  return resolved.origin !== "null" && resolved.origin === base.origin;
}

/**
 * Opens a tour's onward link: in this frame when it stays on the same origin, or replacing the
 * top window when leaving it. Cross-origin frames forbid reading `top.location.assign`
 * (SecurityError), whereas setting `top.location.href` is permitted by the HTML Location spec.
 */
export function navigateContinue(rawUrl: string, win: FrameWindow = window) {
  const href = new URL(rawUrl, win.location.href).toString();
  if (isSameOriginUrl(href, win.location.href)) {
    win.location.assign(href);
    return;
  }
  try {
    if (win.top && win.top !== win) {
      win.top.location.href = href;
      return;
    }
  } catch {
    const opened = win.open?.(href, "_top") ?? win.open?.(href, "_blank", "noopener,noreferrer");
    if (opened) return;
  }
  win.location.assign(href);
}
