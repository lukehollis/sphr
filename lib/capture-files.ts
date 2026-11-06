// What can become a space. Shared by the upload sheet, which says so before a space is made, and the server, which
// refuses to queue a job for files that cannot. On 2026-11-03 an account's first upload was one PDF (a 2D drawing):
// it spent the free preview, ran an agent and failed with a message the sheet could have given up front.

/** Documents, spreadsheets and slides: never a capture on their own, though they may come with one. */
const documentExtensions = new Set(["pdf", "doc", "docx", "odt", "rtf", "txt", "md", "pages", "xls", "xlsx", "ods", "csv", "numbers",
  "ppt", "pptx", "odp", "key", "eml", "msg"]);

export function isDocument(name: string) {
  return documentExtensions.has(name.split(".").pop()?.toLowerCase() ?? "");
}

/** Every file is a document, so there is no capture to build from. An empty list is not. */
export function onlyDocuments(names: string[]) {
  return names.length > 0 && names.every(isDocument);
}

/** The upload sheet's line on what each kind of space needs. */
export const captureKinds = "A 360 tour needs an E57 scan, a Matterport export or link, or 360 photos or video. "
  + "A 3D splat needs a splat file, a 360 video, a phone video walking through the place, or 60 or more overlapping photos.";

export const documentsRefusal = `Drawings and documents, such as PDFs, can't become a space on their own. ${captureKinds}`;
