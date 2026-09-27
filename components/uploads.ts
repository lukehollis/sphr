import { accountRequest } from "./AccountAuth";

/** A file chosen or dropped, with its path inside a dropped folder (or just its name). */
export type PickedFile = { file: File; path: string };

export type Transfer = {
  key: string; name: string; size: number; sent: number;
  state: "waiting" | "uploading" | "retrying" | "done" | "failed"; error?: string;
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Sends one chunk with the resumable protocol; resolves with the status and any persisted offset. */
function sendChunk(url: string, blob: Blob, start: number, total: number, progress: (bytes: number) => void) {
  return new Promise<{ status: number; offset?: number }>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.setRequestHeader("Content-Range", `bytes ${start}-${start + blob.size - 1}/${total}`);
    request.upload.onprogress = event => progress(event.loaded);
    request.onerror = () => reject(new Error("Network error"));
    request.onload = () => {
      const range = request.getResponseHeader("Range")?.match(/^bytes=0-(\d+)$/);
      let offset = range ? Number(range[1]) + 1 : undefined;
      try { offset ??= JSON.parse(request.responseText).offset; } catch { /* Cloud Storage replies with object metadata. */ }
      resolve({ status: request.status, offset });
    };
    request.send(blob);
  });
}

export async function getJson(url: string) {
  const response = await fetch(url, { method: "GET" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong. Try again.");
  return data;
}

/** Uploads one file in resumable chunks, resuming from what storage kept after an interruption. */
export async function uploadFile(spaceId: string, file: File, update: (patch: Partial<Transfer>) => void) {
  const { upload, url, chunkSize } = await accountRequest(`/api/account/spaces/${spaceId}/uploads`, { name: file.name, size: file.size, type: file.type });
  try { await sendFile(upload.id, url, chunkSize, file, update); }
  catch (failure) {
    // A file that gives up leaves nothing half-finished behind to block processing.
    await accountRequest(`/api/account/uploads/${upload.id}`, undefined, "DELETE").catch(() => undefined);
    throw failure;
  }
  await accountRequest(`/api/account/uploads/${upload.id}/complete`);
  update({ sent: file.size, state: "done" });
}

async function sendFile(uploadId: string, url: string, chunkSize: number, file: File, update: (patch: Partial<Transfer>) => void) {
  let offset = 0, failures = 0;
  update({ state: "uploading" });
  while (offset < file.size) {
    const end = Math.min(offset + chunkSize, file.size);
    try {
      const result = await sendChunk(url, file.slice(offset, end), offset, file.size, bytes => update({ sent: offset + bytes }));
      if (result.status === 200 || result.status === 201) offset = file.size;
      else if (result.status === 308) offset = result.offset ?? (await getJson(`/api/account/uploads/${uploadId}`)).offset;
      else if (result.status >= 500 || result.status === 429 || result.status === 416) throw new Error(`HTTP ${result.status}`);
      else throw Object.assign(new Error("The upload was rejected."), { final: true });
      failures = 0;
      update({ sent: offset, state: "uploading" });
    } catch (failure) {
      if ((failure as { final?: boolean }).final || ++failures > 8) throw failure;
      update({ state: "retrying" });
      await wait(Math.min(30000, 1000 * 2 ** failures));
      // Resume from what the storage service actually kept.
      offset = await getJson(`/api/account/uploads/${uploadId}`).then(result => result.offset).catch(() => offset);
    }
  }
}

// System clutter that folders pick up on the way: Finder and Windows metadata, dotfiles.
const clutter = /(?:^|\/)(?:\.[^/]*|__MACOSX|Thumbs\.db|desktop\.ini)(?:\/|$)/i;

export function keepCaptures(files: PickedFile[]) {
  return files.filter(item => item.file.size > 0 && !clutter.test(item.path));
}

export function fromList(list: FileList | File[]): PickedFile[] {
  return Array.from(list).map(file => ({ file, path: file.webkitRelativePath || file.name }));
}

/**
 * Reads dropped files and whole folders. The entries must be taken while the drop
 * event is being handled; walking the folders can finish afterwards.
 */
export function readDrop(transfer: DataTransfer): Promise<PickedFile[]> {
  const entries = Array.from(transfer.items ?? []).filter(item => item.kind === "file").map(item => item.webkitGetAsEntry?.() ?? null);
  if (!entries.length || entries.some(entry => !entry)) return Promise.resolve(fromList(transfer.files));
  const files: PickedFile[] = [];
  async function walk(entry: FileSystemEntry, prefix: string): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      files.push({ file, path: prefix + file.name });
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) return;
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
    }
  }
  return Promise.all(entries.map(entry => walk(entry!, ""))).then(() => files);
}

// Names cameras and scanners give files on their own say nothing about the place.
const cameraNames = /^(?:img|dsc|dscn|dji|pxl|gopr|gs|r00|mvimg|vid|pano|insta|photo|image|scan|capture|untitled|export|download)s?$/i;
const innerExtensions = /\.(?:tar|spark|compressed|splat|ply)$/i;

function tidy(value: string) {
  const text = value
    .replace(/_+/g, " ")
    .replace(/(\D)-+|-+(\D)/g, "$1 $2")
    .replace(/\s*\(\d+\)$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return text && text === text.toLowerCase() ? text[0].toUpperCase() + text.slice(1) : text;
}

function baseName(name: string) {
  return name.replace(/\.[a-z0-9]{1,8}$/i, "").replace(innerExtensions, "");
}

/** Whether a name reads like a title rather than a counter or a camera default. */
function meaningful(value: string) {
  const words = value.replace(/[\d\s._-]+/g, " ").trim();
  return words.length >= 3 && !cameraNames.test(words);
}

/**
 * A title from what was dropped: the folder's name, the one file's name, or the
 * part every file name shares. Counters and camera defaults fall back to the date.
 */
export function titleFromFiles(files: PickedFile[], now = new Date()) {
  const folders = new Set(files.map(item => item.path.includes("/") ? item.path.split("/")[0] : ""));
  const folder = folders.size === 1 ? [...folders][0] : "";
  if (folder && meaningful(folder)) return tidy(folder).slice(0, 200);
  const names = files.map(item => baseName(item.file.name));
  if (names.length) {
    // The largest file is usually the capture itself; the rest are sidecars.
    const main = baseName([...files].sort((a, b) => b.file.size - a.file.size)[0].file.name);
    let shared = names[0];
    for (const name of names) while (!name.startsWith(shared)) shared = shared.slice(0, -1);
    shared = shared.replace(/[\s._-]*\d*[\s._-]*$/, "");
    for (const candidate of names.length === 1 ? [main] : [shared, main]) {
      if (meaningful(candidate)) return tidy(candidate).slice(0, 200);
    }
  }
  return `Capture from ${now.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}
