/**
 * What an owner or the operator says about a space beyond its title: where it is, who
 * captured it and when, whom to contact. Shown in the viewer's details panel.
 */
export type SpaceInfo = {
  description?: string;
  location?: string;
  capturedBy?: string;
  capturedOn?: string;
  contact?: string;
  website?: string;
  credits?: string;
};

export const spaceInfoLimits = { description: 2000, location: 200, capturedBy: 200, capturedOn: 10, contact: 300, website: 300, credits: 1000 } as const;
type TextKey = keyof typeof spaceInfoLimits;

const email = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/** A web address as typed, with https added when it has no scheme; undefined when it is not one. */
export function webAddress(value: string) {
  const text = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(text);
    return /^https?:$/.test(url.protocol) && url.hostname.includes(".") ? url.toString() : undefined;
  } catch { return undefined; }
}

/** Where a contact entry leads: an email address or a web page. */
export function contactHref(value: string) {
  return email.test(value) ? `mailto:${value}` : webAddress(value);
}

/** A capture date kept as YYYY, YYYY-MM or YYYY-MM-DD, shown in the visitor's words. */
export function formatCapturedOn(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  if (!month) return String(year);
  const date = new Date(Date.UTC(year, month - 1, day || 1));
  return date.toLocaleDateString(undefined, { timeZone: "UTC", year: "numeric", month: "long", ...(day ? { day: "numeric" } : {}) });
}

function text(value: unknown, max: number, multiline = false) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new SpaceInfoError("Details must be text.");
  const cleaned = multiline
    ? value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()
    : value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length > max) throw new SpaceInfoError(`Keep it under ${max} characters.`);
  return cleaned || undefined;
}

export class SpaceInfoError extends Error {}

/** Checks details sent by an editor, keeping only what is filled in. */
export function parseSpaceInfo(value: unknown): SpaceInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SpaceInfoError("Send the details as an object.");
  const input = value as Record<string, unknown>;
  const info: SpaceInfo = {};
  for (const key of Object.keys(spaceInfoLimits) as TextKey[]) {
    const result = text(input[key], spaceInfoLimits[key], key === "description" || key === "credits");
    if (result) info[key] = result;
  }
  if (info.capturedOn && !/^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/.test(info.capturedOn)) {
    throw new SpaceInfoError("Enter the capture date as a year, a month or a day.");
  }
  if (info.contact && !contactHref(info.contact)) throw new SpaceInfoError("Enter an email address or a web address for the contact.");
  if (info.website) {
    const address = webAddress(info.website);
    if (!address) throw new SpaceInfoError("Enter a web address for the website, like example.com.");
    info.website = address;
  }
  return info;
}
