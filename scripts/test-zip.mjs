// The streamed zip behind "Download everything" (lib/server/zip.ts): exact lengths, checksums that
// the usual tools accept, zip64 where needed, and sources read only as fast as the download goes.
//   node --test scripts/test-zip.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bufferFile, httpSource, safeZipName, zipChunks, zipLength, zipStream } from '../lib/server/zip.ts';

async function collect(files, options) {
  const parts = [];
  for await (const chunk of zipChunks(files, options)) parts.push(chunk);
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

/**
 * Stand-in storage over HTTP: serves `files` by path and answers Range requests as storage does.
 * `fault` hears each request (its path and how many times that path was asked for) and may make
 * storage answer with an error `status`, send only `cut` bytes and drop the connection, or
 * `ignoreRange` and send the whole file again.
 */
async function storage(files, fault = () => undefined) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push([request.url, request.headers.range ?? null]);
    const { status, cut, ignoreRange } = fault(request.url, requests.filter(([url]) => url === request.url).length) ?? {};
    const bytes = files[request.url];
    if (status || !bytes) { response.writeHead(status ?? 404).end(); return; }
    const start = ignoreRange ? 0 : Number(request.headers.range?.match(/^bytes=(\d+)-$/)?.[1] ?? 0);
    response.writeHead(start ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length - start,
      ...(start ? { 'Content-Range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {}) });
    // A dropped connection: part of the body, then the socket closes once the reader has had time to take that part.
    if (cut !== undefined) response.write(bytes.subarray(start, start + cut), () => setTimeout(() => response.destroy(), 150));
    else response.end(bytes.subarray(start));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { requests, files, asked: (url) => requests.filter(([path]) => path === url).map(([, range]) => range),
    file: (name, url, size) => ({ name, size, open: httpSource(url, (signal, headers) => fetch(base + url, { headers, signal })) }),
    close: () => { server.closeAllConnections(); server.close(); } };
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

test('a file storage fails to send, or whose connection drops partway, is read again from the byte it reached', async () => {
  const mesh = Buffer.alloc(400_000).map((_, index) => (index * 7) % 253);
  const face = Buffer.alloc(50_000).map((_, index) => (index * 3) % 241);
  const pano = Buffer.alloc(30_000).map((_, index) => (index * 5) % 239);
  // The mesh's connection drops twice partway, the face is refused once by a busy server, and the
  // panorama, of a size no listing gave, drops once before its first byte.
  const store = await storage({ '/mesh.glb': mesh, '/face0.jpg': face, '/pano.jpg': pano }, (url, count) =>
    url === '/mesh.glb' && count <= 2 ? { cut: 150_000 } : url === '/face0.jpg' && count === 1 ? { status: 503 } : url === '/pano.jpg' && count === 1 ? { cut: 0 } : undefined);
  const retried = [];
  try {
    const listed = [bufferFile('space/README.txt', Buffer.from('What each file is\n')), store.file('space/mesh/scan.glb', '/mesh.glb', mesh.length),
      store.file('space/faces/ab12/face0.jpg', '/face0.jpg', face.length)];
    const bytes = await collect(listed, { retries: [20, 20, 20, 20], onRetry: (name) => retried.push(name) });
    assert.equal(bytes.length, zipLength(listed), 'the archive is exactly as long as announced');
    assert.deepEqual(readBack(bytes), [['space/README.txt', 18, await hash(Buffer.from('What each file is\n'))],
      ['space/mesh/scan.glb', mesh.length, await hash(mesh)], ['space/faces/ab12/face0.jpg', face.length, await hash(face)]], 'and every file in it is whole');
    const unlisted = await collect([store.file('space/pano/001.jpg', '/pano.jpg', null)], { retries: [20] });
    assert.deepEqual(readBack(unlisted), [['space/pano/001.jpg', pano.length, await hash(pano)]]);
  } finally { store.close(); }
  assert.deepEqual([store.asked('/mesh.glb'), store.asked('/face0.jpg'), store.asked('/pano.jpg')],
    [[null, 'bytes=150000-', 'bytes=300000-'], [null, null], [null, null]], 'each read again asks only for the rest');
  assert.ok(store.requests.findLastIndex(([url]) => url === '/face0.jpg') > store.requests.findLastIndex(([url]) => url === '/mesh.glb'),
    'a file whose early open failed is asked for again in its turn');
  assert.deepEqual(retried, ['space/mesh/scan.glb', 'space/mesh/scan.glb', 'space/faces/ab12/face0.jpg']);
});

test('a file read again must be the same file, and one that keeps failing still fails the archive', async () => {
  const mesh = Buffer.alloc(100_000, 7);
  // Storage that holds a longer file by the time the rest is asked for, one that sends the whole file again, and one that keeps dropping.
  const store = await storage({ '/grown.glb': mesh, '/whole.glb': mesh, '/drops.glb': mesh }, (url, count) => {
    if (url === '/grown.glb' && count === 2) store.files['/grown.glb'] = Buffer.concat([mesh, mesh]);
    return url === '/drops.glb' ? { cut: 10_000 } : count === 1 ? { cut: 40_000 } : url === '/whole.glb' ? { ignoreRange: true } : undefined;
  });
  const options = { retries: [20, 20, 20, 20] };
  try {
    await assert.rejects(collect([store.file('a/grown.glb', '/grown.glb', mesh.length)], options), /a\/grown\.glb is 200000 bytes now, not the 100000 it was/);
    await assert.rejects(collect([store.file('a/whole.glb', '/whole.glb', mesh.length)], options), /Reading \/whole\.glb again from byte 40000 failed: HTTP 200 without a range/);
    await assert.rejects(collect([store.file('a/missing.glb', '/missing.glb', mesh.length)], options), /Reading \/missing\.glb failed: HTTP 404/);
    await assert.rejects(collect([store.file('a/drops.glb', '/drops.glb', mesh.length)], options), /terminated/);
  } finally { store.close(); }
  assert.deepEqual([store.asked('/grown.glb'), store.asked('/whole.glb'), store.asked('/missing.glb')], [[null, 'bytes=40000-'], [null, 'bytes=40000-'], [null]],
    'a file that is gone or no longer the same is not asked for again');
  assert.deepEqual(store.asked('/drops.glb'), [null, 'bytes=10000-', 'bytes=20000-', 'bytes=30000-', 'bytes=40000-'], 'one that keeps breaking off is read on four more times');
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
