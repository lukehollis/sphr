import { setTimeout as sleep } from "node:timers/promises";
import { crc32 } from "node:zlib";

/**
 * A zip archive written as it goes, for downloads too big to hold in memory. Files are
 * stored as they are (no compression: photos, meshes and splats are compressed already),
 * each followed by a data descriptor, so a file's checksum is worked out while it streams.
 * Zip64 records are added where a file, an offset or the file count outgrows the classic
 * format, so archives over 4 GB open in the usual tools.
 */

/**
 * One file in an archive. `size` is known ahead (from a listing) or null; `open` gives its bytes
 * from `start` on (0 unless an earlier read broke off) and, once fetched, the whole file's size.
 */
export type ZipFile = {
  name: string;
  size: number | null;
  modified?: Date;
  open: (signal: AbortSignal, start?: number) => Promise<{ size: number | null; chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array> }>;
};

// A file whose read fails (storage busy, a connection dropped) is read again after each of these pauses, in milliseconds, from the byte it reached.
const RETRIES = [1000, 2000, 5000, 15000];

/** A failure that reading again would only repeat: the file is missing, refused, or no longer the one that was listed. */
class Lasting extends Error {}

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
// Unix 3.0 (made by) and 4.5, the version that reads zip64 (needed).
const MADE_BY = (3 << 8) | 45;
// Bit 3: sizes and checksum follow the data. Bit 11: names are UTF-8.
const FLAGS = 0x0808;

// The extended timestamp field: the time in seconds since 1970, which tools prefer to the local DOS time.
const STAMP = 9;
function stamp(bytes: Buffer, at: number, when: Date) {
  bytes.writeUInt16LE(0x5455, at);
  bytes.writeUInt16LE(5, at + 2);
  bytes.writeUInt8(1, at + 4);
  bytes.writeUInt32LE(Math.max(0, Math.min(MAX32, Math.floor(when.getTime() / 1000))), at + 5);
}

/**
 * A file over 4 GB carries zip64 sizes. One whose size is not known when its header is written
 * does not: macOS Archive Utility misreads zip64 sizes on small files, and storage always
 * reports the size of anything that large, so an unknown file that outgrows 4 GB fails instead.
 */
const large = (size: number | null) => size !== null && size >= MAX32;

/** A buffer of `bytes` already in memory, as a file. */
export function bufferFile(name: string, bytes: Uint8Array, modified?: Date): ZipFile {
  return { name, size: bytes.length, modified, open: async (_signal, start = 0) => ({ size: bytes.length, chunks: [bytes.subarray(start)] }) };
}

/**
 * Opens a file kept behind HTTP, fetched by `request` with these headers added to its own. A read
 * from partway asks for the rest with a Range request and takes only the rest of the same file:
 * a 206 from that very byte, whose Content-Range gives the whole length to check against.
 */
export function httpSource(name: string, request: (signal: AbortSignal, headers: Record<string, string>) => Promise<Response>): ZipFile["open"] {
  return async (signal, start = 0) => {
    const result = await request(signal, { "Accept-Encoding": "identity", ...(start ? { Range: `bytes=${start}-` } : {}) });
    const range = start ? result.headers.get("content-range")?.match(/^bytes (\d+)-(\d+)\/(\d+)$/) : null;
    const failure = !result.ok || !result.body ? `Reading ${name} failed: HTTP ${result.status}`
      : start && (result.status !== 206 || !range || Number(range[1]) !== start || Number(range[2]) + 1 !== Number(range[3]))
        ? `Reading ${name} again from byte ${start} failed: HTTP ${result.status} ${result.headers.get("content-range") ?? "without a range"}` : null;
    if (failure) {
      await result.body?.cancel().catch(() => undefined);
      // Storage that is slow or busy may answer next time; a file that is missing or refused, or the whole file again, will not.
      throw result.status === 408 || result.status === 429 || result.status >= 500 ? new Error(failure) : new Lasting(failure);
    }
    const encoded = result.headers.get("content-encoding") && result.headers.get("content-encoding") !== "identity";
    return {
      size: range ? Number(range[3]) : encoded || !result.headers.has("content-length") ? null : Number(result.headers.get("content-length")),
      // Node's fetch cancels a body once its response is garbage collected, so the response stays
      // reachable until its bytes are read (a file opened ahead can wait a while for its turn).
      chunks: (async function* () { for await (const chunk of result.body as unknown as AsyncIterable<Uint8Array>) yield chunk; })()
    };
  };
}

/** A name stays inside the archive's folder: no absolute paths, no `..`, no backslashes or control characters. */
export function safeZipName(name: string) {
  return name.length > 0 && name.length <= 1024 && !name.startsWith("/") && !/[\\\u0000-\u001f]/.test(name)
    && name.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function dosTime(date: Date) {
  const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107);
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate()
  };
}

function localHeader(name: Buffer, big: boolean, when: Date) {
  const header = Buffer.alloc(30 + name.length + (big ? 20 : 0) + STAMP);
  const { time, date } = dosTime(when);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(big ? 45 : 20, 4);
  header.writeUInt16LE(FLAGS, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(date, 12);
  // Checksum and sizes are zero here: they follow the data.
  header.writeUInt32LE(big ? MAX32 : 0, 18);
  header.writeUInt32LE(big ? MAX32 : 0, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE((big ? 20 : 0) + STAMP, 28);
  name.copy(header, 30);
  if (big) {
    header.writeUInt16LE(0x0001, 30 + name.length);
    header.writeUInt16LE(16, 32 + name.length);
  }
  stamp(header, 30 + name.length + (big ? 20 : 0), when);
  return header;
}

function descriptor(crc: number, size: number, big: boolean) {
  const bytes = Buffer.alloc(big ? 24 : 16);
  bytes.writeUInt32LE(0x08074b50, 0);
  bytes.writeUInt32LE(crc >>> 0, 4);
  if (big) { bytes.writeBigUInt64LE(BigInt(size), 8); bytes.writeBigUInt64LE(BigInt(size), 16); }
  else { bytes.writeUInt32LE(size, 8); bytes.writeUInt32LE(size, 12); }
  return bytes;
}

type Written = { name: Buffer; big: boolean; when: Date; crc: number; size: number; offset: number };

function centralHeader(file: Written) {
  // A file whose local header has zip64 sizes keeps them here too; a far offset adds its own field.
  const farOffset = file.offset >= MAX32;
  const extra = (file.big ? 16 : 0) + (farOffset ? 8 : 0);
  const header = Buffer.alloc(46 + file.name.length + (extra ? 4 + extra : 0) + STAMP);
  const { time, date } = dosTime(file.when);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(MADE_BY, 4);
  header.writeUInt16LE(file.big || farOffset ? 45 : 20, 6);
  header.writeUInt16LE(FLAGS, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(time, 12);
  header.writeUInt16LE(date, 14);
  header.writeUInt32LE(file.crc >>> 0, 16);
  header.writeUInt32LE(file.big ? MAX32 : file.size, 20);
  header.writeUInt32LE(file.big ? MAX32 : file.size, 24);
  header.writeUInt16LE(file.name.length, 28);
  header.writeUInt16LE((extra ? 4 + extra : 0) + STAMP, 30);
  // Comment length, disk, internal attributes stay zero; a regular file readable by everyone.
  header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  header.writeUInt32LE(farOffset ? MAX32 : file.offset, 42);
  file.name.copy(header, 46);
  if (extra) {
    let at = 46 + file.name.length;
    header.writeUInt16LE(0x0001, at); header.writeUInt16LE(extra, at + 2); at += 4;
    if (file.big) { header.writeBigUInt64LE(BigInt(file.size), at); header.writeBigUInt64LE(BigInt(file.size), at + 8); at += 16; }
    if (farOffset) header.writeBigUInt64LE(BigInt(file.offset), at);
  }
  stamp(header, 46 + file.name.length + (extra ? 4 + extra : 0), file.when);
  return header;
}

function endRecords(count: number, start: number, size: number) {
  const zip64 = count >= MAX16 || start >= MAX32 || size >= MAX32;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Math.min(count, MAX16), 8);
  end.writeUInt16LE(Math.min(count, MAX16), 10);
  end.writeUInt32LE(Math.min(size, MAX32), 12);
  end.writeUInt32LE(Math.min(start, MAX32), 16);
  if (!zip64) return end;
  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeUInt16LE(MADE_BY, 12);
  record.writeUInt16LE(45, 14);
  record.writeBigUInt64LE(BigInt(count), 24);
  record.writeBigUInt64LE(BigInt(count), 32);
  record.writeBigUInt64LE(BigInt(size), 40);
  record.writeBigUInt64LE(BigInt(start), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(start + size), 8);
  locator.writeUInt32LE(1, 16);
  return Buffer.concat([record, locator, end]);
}

/** The archive's length in bytes when every file's size is known ahead, otherwise null. */
export function zipLength(files: ZipFile[]) {
  let offset = 0;
  let central = 0;
  for (const file of files) {
    if (file.size === null) return null;
    const name = Buffer.byteLength(file.name);
    const big = large(file.size);
    central += 46 + name + (big || offset >= MAX32 ? 4 + (big ? 16 : 0) + (offset >= MAX32 ? 8 : 0) : 0) + STAMP;
    offset += 30 + name + (big ? 20 : 0) + STAMP + file.size + (big ? 24 : 16);
  }
  const zip64 = files.length >= MAX16 || offset >= MAX32 || central >= MAX32;
  return offset + central + 22 + (zip64 ? 76 : 0);
}

/**
 * The archive's bytes, one file after another. Up to `ahead` files are opened before their
 * turn, so the wait for each starts early, but only the file being written is read: a slow
 * download reads its sources slowly too. A file whose bytes differ from its stated size fails
 * the archive, so a listing that went stale never yields a broken zip that looks complete. A file
 * that fails to open, or breaks off partway, is opened again from the byte it reached, after each
 * pause in `retries`, and must still have the same length; then the archive fails.
 */
export async function* zipChunks(files: ZipFile[], { signal = new AbortController().signal, ahead = 4, retries = RETRIES,
  onRetry }: { signal?: AbortSignal; ahead?: number; retries?: number[]; onRetry?: (name: string, error: unknown) => void } = {}): AsyncGenerator<Uint8Array> {
  for (const file of files) if (!safeZipName(file.name)) throw new Error(`Unsafe name in archive: ${file.name}`);
  const opened: Promise<Awaited<ReturnType<ZipFile["open"]>>>[] = [];
  const openAt = (index: number) => {
    if (index < files.length && !opened[index]) {
      opened[index] = files[index].open(signal);
      // Failures surface when the file's turn comes; until then they are not unhandled.
      opened[index].catch(() => undefined);
    }
  };
  const written: Written[] = [];
  let offset = 0;
  for (let index = 0; index < files.length; index++) {
    for (let next = index; next <= index + ahead; next++) openAt(next);
    const file = files[index];
    let expected = file.size;
    let entry: Written | undefined;
    for (let failures = 0; ; failures++) {
      try {
        // The first read was opened ahead; a read again starts from the byte the last one reached.
        const source = await (failures ? file.open(signal, entry?.size ?? 0) : opened[index]);
        if (expected !== null && source.size !== null && expected !== source.size) {
          throw new Lasting(entry ? `${file.name} is ${source.size} bytes now, not the ${expected} it was.` : `${file.name} is ${source.size} bytes, not the ${expected} listed.`);
        }
        expected ??= source.size;
        if (!entry) {
          entry = { name: Buffer.from(file.name), big: large(expected), when: file.modified ?? new Date(), crc: 0, size: 0, offset };
          const header = localHeader(entry.name, entry.big, entry.when);
          yield header;
          offset += header.length;
        }
        for await (const chunk of source.chunks) {
          if (signal.aborted) throw signal.reason ?? new Error("Download stopped.");
          entry.crc = crc32(chunk, entry.crc);
          entry.size += chunk.length;
          yield chunk;
        }
        break;
      } catch (error) {
        if (signal.aborted || error instanceof Lasting || failures >= retries.length) throw error;
        onRetry?.(file.name, error);
        await sleep(retries[failures], undefined, { signal });
      }
    }
    if (expected !== null && entry.size !== expected) throw new Error(`${file.name} ended at ${entry.size} of ${expected} bytes.`);
    if (!entry.big && entry.size >= MAX32) throw new Error(`${file.name} outgrew its header.`);
    const tail = descriptor(entry.crc, entry.size, entry.big);
    yield tail;
    offset += entry.size + tail.length;
    written.push(entry);
    delete opened[index];
  }
  const start = offset;
  let size = 0;
  for (const entry of written) {
    const header = centralHeader(entry);
    size += header.length;
    yield header;
  }
  yield endRecords(written.length, start, size);
}

/**
 * A byte stream of the archive that reads its sources only as fast as the reader takes it.
 * Cancelling it (the visitor stops the download) aborts the files being fetched.
 */
export function zipStream(files: ZipFile[], { onError, onClose, onRetry }: { onError?: (error: unknown) => void; onClose?: () => void;
  onRetry?: (name: string, error: unknown) => void } = {}) {
  const controller = new AbortController();
  const chunks = zipChunks(files, { signal: controller.signal, onRetry });
  let closed = false;
  const close = () => { if (!closed) { closed = true; onClose?.(); } };
  return new ReadableStream<Uint8Array>({
    async pull(stream) {
      try {
        const next = await chunks.next();
        if (controller.signal.aborted) return;
        if (next.done) { close(); stream.close(); }
        else stream.enqueue(next.value);
      } catch (error) {
        // A download the visitor stopped is not a failure.
        if (controller.signal.aborted) return;
        controller.abort(error);
        onError?.(error);
        close();
        stream.error(error);
      }
    },
    async cancel(reason) {
      controller.abort(reason ?? new Error("Download stopped."));
      close();
      await chunks.return(undefined).catch(() => undefined);
    }
  }, { highWaterMark: 1 });
}
