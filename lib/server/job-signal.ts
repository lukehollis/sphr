// Wakes long-polling workers when a job is queued. Kept on globalThis so every route
// bundle in this single Node process shares one signal.
const store = globalThis as typeof globalThis & { __sphrJobSignal?: EventTarget };
const signal = (store.__sphrJobSignal ??= new EventTarget());

export function announceJob() {
  signal.dispatchEvent(new Event("queued"));
}

/** Resolves when a job is queued or after `ms`, whichever comes first. */
export function waitForJob(ms: number, abort?: AbortSignal) {
  return new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("queued", done); abort?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("queued", done);
    abort?.addEventListener("abort", done);
  });
}
