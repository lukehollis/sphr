import { GraphicsUnavailable } from "@/lib/three/glContext";

/**
 * Something the opening view can't do without never came, so the space can't open: the site reconstruction at a
 * tour's first stop, refused by a school's network, say. The message is for the visitor, `details` says why.
 */
export class PartMissing extends Error {
  constructor(message: string, readonly part: "reconstruction", readonly details: string) {
    super(message);
  }
}

/**
 * Why a space couldn't open, as the page reports it: the client_error's kind, the reason in a few words (the
 * client_error's message, and what a framing page hears with spacery:error) and what else is known about it.
 */
export type StartFailure = { kind: string; reason: string; details: string };

/** The page's own scripts, where a start-up failure that is a bug in them was thrown. */
const ourFrame = /(\/_next\/[^\s()]+:\d+:\d+)/;

export function startFailure(error: unknown): StartFailure {
  if (error instanceof GraphicsUnavailable) {
    const reason = error.graphics === "none" ? "No WebGL 2 at start"
      : error.graphics === "loop" ? "WebGL context lost in a loop at start" : "WebGL context lost at start";
    return { kind: "webgl", reason, details: error.details };
  }
  if (error instanceof PartMissing) return { kind: error.part, reason: `The ${error.part} did not load at start`, details: error.details };
  if (error instanceof Error) {
    const said = error.name && error.name !== "Error" ? `${error.name}: ${error.message}` : error.message;
    return { kind: "startup", reason: (said || error.name || "Unknown error").slice(0, 200), details: ourFrame.exec(error.stack ?? "")?.[1] ?? "" };
  }
  // A loader can reject with an image's error event rather than an Error.
  const what = typeof error === "string" ? error : typeof Event !== "undefined" && error instanceof Event ? `${error.type} event` : "";
  return { kind: "startup", reason: (what || "Unknown runtime error").slice(0, 200), details: "" };
}
