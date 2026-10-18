/** What three.js asks for too, so the renderer takes over the context opened here. */
const ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  depth: true,
  stencil: false,
  antialias: false,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
  powerPreference: "high-performance",
  failIfMajorPerformanceCaveat: false
};

/** How long a context lost from the start gets to come back while the page is in view. */
const WAIT_MS = 3000;

export type Graphics = "ready" | "lost" | "none";

/** The space can't be drawn: the browser gave no WebGL 2, or only a lost context. */
export class GraphicsUnavailable extends Error {
  constructor(readonly graphics: Exclude<Graphics, "ready">, readonly details = "") {
    super(graphics === "none"
      ? "This browser can't show 3D graphics. Turn on hardware acceleration in its settings or open the space in another browser."
      : "The browser wouldn't start 3D graphics for this page. Close other tabs with 3D spaces in them, or quit and reopen the browser, then press Retry.");
  }
}

/**
 * Opens a canvas's WebGL 2 context and says whether it can draw. Safari can hand a page a context that is lost from
 * the start, and three.js then fails on `getShaderPrecisionFormat(...).precision`, which a lost context answers with null.
 */
export function openContext(canvas: HTMLCanvasElement, lowPower = false): Graphics {
  // A lost context comes back only if its loss was prevented, and that event can come before three.js listens.
  canvas.addEventListener("webglcontextlost", (event) => event.preventDefault());
  return graphicsOf(canvas, lowPower ? { ...ATTRIBUTES, powerPreference: "default" } : ATTRIBUTES);
}

/** Whether the canvas's context (opened already, or now) can draw. */
export function graphicsOf(canvas: HTMLCanvasElement, attributes = ATTRIBUTES): Graphics {
  const gl = canvas.getContext("webgl2", attributes);
  if (!gl) return "none";
  return gl.isContextLost() || !gl.getShaderPrecisionFormat(gl.VERTEX_SHADER, gl.HIGH_FLOAT) ? "lost" : "ready";
}

/**
 * Waits for a canvas's lost context to come back: for as long as the page is hidden (a tab opened or restored in the
 * background may get its context only once shown), then up to WAIT_MS in view.
 */
export function contextBack(canvas: HTMLCanvasElement, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (back: boolean) => {
      clearTimeout(timer);
      canvas.removeEventListener("webglcontextrestored", restored);
      document.removeEventListener("visibilitychange", shown);
      signal.removeEventListener("abort", aborted);
      resolve(back);
    };
    const restored = () => finish(graphicsOf(canvas) === "ready");
    const aborted = () => finish(false);
    const shown = () => {
      clearTimeout(timer);
      if (!document.hidden) timer = setTimeout(() => finish(graphicsOf(canvas) === "ready"), WAIT_MS);
    };
    if (signal.aborted) return resolve(false);
    canvas.addEventListener("webglcontextrestored", restored);
    document.addEventListener("visibilitychange", shown);
    signal.addEventListener("abort", aborted);
    shown();
  });
}
