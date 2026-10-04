// Wakes long-polling workers when a job is queued. Kept on globalThis so every route
// bundle in this single Node process shares one signal.
const store = globalThis as typeof globalThis & { __sphrJobSignal?: EventTarget; __sphrStopping?: boolean };
const signal = (store.__sphrJobSignal ??= new EventTarget());

// A deploy stops the server with SIGTERM, and Next.js then waits for open requests to end.
// Release waiting workers at once so the old server exits in a moment instead of holding
// the site down until systemd gives up on it.
if (store.__sphrStopping === undefined) {
  store.__sphrStopping = false;
  process.once("SIGTERM", () => {
    store.__sphrStopping = true;
    signal.dispatchEvent(new Event("queued"));
  });
}

export function announceJob() {
  signal.dispatchEvent(new Event("queued"));
}

/** Resolves when a job is queued, the server is stopping, or after `ms`, whichever comes first. */
export function waitForJob(ms: number, abort?: AbortSignal) {
  return new Promise<void>(resolve => {
    if (store.__sphrStopping) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener("queued", done); abort?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("queued", done);
    abort?.addEventListener("abort", done);
  });
}
