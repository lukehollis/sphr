// The streamed zip behind "Download everything" (lib/server/zip.ts): exact lengths, checksums that
// the usual tools accept, zip64 where needed, and sources read only as fast as the download goes.
//   node --test scripts/test-zip.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bufferFile, safeZipName, zipChunks, zipLength, zipStream } from '../lib/server/zip.ts';

async function collect(files) {
  const parts = [];
  for await (const chunk of zipChunks(files)) parts.push(chunk);
  return Buffer.concat(parts);
}

/**
 * What Python's zipfile reads back: each name, size and a hash of its bytes, after checking every
 * checksum. On a Mac, Archive Utility's engine (ditto) must unpack the same bytes too.
 */
function readBack(bytes) {
  const folder = mkdtempSync(path.join(tmpdir(), 'sphr-zip-'));
  try {
    const file = path.join(folder, 'test.zip');
    writeFileSync(file, bytes);
    const script = `import hashlib, json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
print(json.dumps([[i.filename, i.file_size, hashlib.sha256(z.read(i)).hexdigest()[:12]] for i in z.infolist()]))`;
    const read = JSON.parse(execFileSync('python3', ['-I', '-c', script, file], { maxBuffer: 64 << 20 }).toString());
    if (process.platform === 'darwin' && read.length < 1000) {
      execFileSync('ditto', ['-x', '-k', file, path.join(folder, 'out')]);
      for (const [name, size] of read) assert.equal(readFileSync(path.join(folder, 'out', name)).length, size, `ditto unpacks ${name}`);
    }
    return read;
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

const hash = async (bytes) => (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex').slice(0, 12);

/** A file streamed in uneven chunks, as a storage response arrives. */
function streamed(name, bytes, { size = bytes.length, reported = bytes.length } = {}) {
  return { name, size, open: async () => ({ size: reported, chunks: (async function* () {
    for (let at = 0; at < bytes.length; at += 7001) yield bytes.subarray(at, at + 7001);
  })() }) };
}

test('the archive is exactly as long as worked out ahead, and every file reads back intact', async () => {
  const photo = Buffer.alloc(150_000).map((_, index) => (index * 31) % 251);
  const files = [bufferFile('space/README.txt', Buffer.from('What each file is\n')), bufferFile('space/tags.json', Buffer.from('[]\n')),
    streamed('space/faces/ab12/face0.jpg', photo), bufferFile('space/empty.txt', Buffer.alloc(0)), bufferFile('space/Café ünïcode.json', Buffer.from('{}'))];
  const bytes = await collect(files);
  assert.equal(bytes.length, zipLength(files));
  assert.deepEqual(readBack(bytes), [['space/README.txt', 18, await hash(Buffer.from('What each file is\n'))], ['space/tags.json', 3, await hash(Buffer.from('[]\n'))],
    ['space/faces/ab12/face0.jpg', photo.length, await hash(photo)], ['space/empty.txt', 0, await hash(Buffer.alloc(0))], ['space/Café ünïcode.json', 2, await hash(Buffer.from('{}'))]]);
});

test('a file of unknown size streams too, and the archive length is then unknown', async () => {
  const bytes = Buffer.from('x'.repeat(5000));
  const files = [bufferFile('a/one.txt', Buffer.from('one')), { ...streamed('a/unknown.bin', bytes, { reported: null }), size: null }];
  assert.equal(zipLength(files), null);
  assert.deepEqual(readBack(await collect(files)), [['a/one.txt', 3, await hash(Buffer.from('one'))], ['a/unknown.bin', 5000, await hash(bytes)]]);
});

test('more than 65,535 files get zip64 end records', async () => {
  const files = Array.from({ length: 65_600 }, (_, index) => bufferFile(`many/${index}.txt`, Buffer.from(String(index))));
  const bytes = await collect(files);
  assert.equal(bytes.length, zipLength(files));
  const read = readBack(bytes);
  assert.equal(read.length, 65_600);
  assert.deepEqual(read.at(-1), ['many/65599.txt', 5, await hash(Buffer.from('65599'))]);
});

test('a file whose bytes differ from its listed size fails the archive instead of ending it early', async () => {
  const bytes = Buffer.from('abcdef');
  await assert.rejects(collect([streamed('a/stale.bin', bytes, { size: 10, reported: null })]), /ended at 6 of 10 bytes/);
  await assert.rejects(collect([streamed('a/changed.bin', bytes, { size: 10 })]), /6 bytes, not the 10 listed/);
});

test('names stay inside the archive folder', async () => {
  for (const name of ['/etc/passwd', 'a/../b', 'a//b', 'a\\b', './a', 'a/\u0000', '']) assert.equal(safeZipName(name), false, name);
  assert.equal(safeZipName('space/faces/ab12/face0.jpg'), true);
  await assert.rejects(collect([bufferFile('a/../../escape.txt', Buffer.from('x'))]), /Unsafe name/);
});

test('the stream reads ahead only a little, and cancelling it aborts the files being fetched', async () => {
  let produced = 0;
  let aborted = 0;
  const endless = (name) => ({ name, size: 1 << 30, open: async (signal) => {
    signal.addEventListener('abort', () => { aborted += 1; });
    return { size: 1 << 30, chunks: (async function* () { while (!signal.aborted) { produced += 65536; yield new Uint8Array(65536); } })() };
  } });
  let closed = 0;
  const stream = zipStream([endless('big/one.bin'), endless('big/two.bin')], { onClose: () => { closed += 1; } });
  const reader = stream.getReader();
  for (let index = 0; index < 4; index++) await reader.read();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(produced <= 65536 * 6, `only what was asked for is read (${produced} bytes)`);
  await reader.cancel();
  assert.equal(closed, 1);
  assert.equal(aborted, 2, 'both the file being written and the one opened ahead are aborted');
});
