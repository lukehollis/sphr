/**
 * Whether this browser should keep to light copies: mid-size panorama faces, the lighter
 * capture model and a smaller texture budget. Phones and small tablets do, and so does any
 * browser asking to save data. `?light=1` or `?light=0` on the page decides it for testing.
 */
export function prefersLight() {
  if (typeof window === "undefined") return false;
  const asked = new URLSearchParams(window.location.search).get("light");
  if (asked === "1" || asked === "0") return asked === "1";
  const nav = navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string }; deviceMemory?: number };
  if (nav.connection?.saveData || /2g$/.test(nav.connection?.effectiveType ?? "")) return true;
  if (typeof nav.deviceMemory === "number" && nav.deviceMemory < 4) return true;
  const touch = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  return touch && Math.min(window.screen.width, window.screen.height) < 820;
}
