/**
 * The browser side of class results (lib/server/tour-plays.ts): starts a play with the
 * player's name and sends its progress as it changes, every minute while the page is looked
 * at, and when the page is left. A play lasts for the browser session, so a reload continues it.
 */
export type PlayProgress = { found: number; steps: number; stop: number; stops: number; finished: boolean };

const storageKey = (tourId: string) => `sphr-play:${tourId}`;

export function savedPlay(tourId: string) {
  try { return sessionStorage.getItem(storageKey(tourId)); } catch { return null; }
}

export async function startPlay(tourId: string, name: string) {
  try {
    const response = await fetch(`/api/tours/${tourId}/plays`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }), credentials: "same-origin" });
    const result = await response.json().catch(() => ({}));
    const play = typeof result.play === "string" ? result.play : null;
    if (play) {
      try { sessionStorage.setItem(storageKey(tourId), play); } catch { /* private browsing keeps it for this page only */ }
    }
    return play;
  } catch {
    return null;
  }
}

export function sendProgress(tourId: string, play: string, progress: PlayProgress, seconds: number) {
  try {
    void fetch(`/api/tours/${tourId}/plays/${play}`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...progress, seconds: Math.round(seconds) }), credentials: "same-origin", keepalive: true }).catch(() => undefined);
  } catch { /* the next change tries again */ }
}
