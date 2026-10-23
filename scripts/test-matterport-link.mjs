// The Matterport link downloader (scripts/worker/matterport-link.mjs) against an in-memory Matterport.
//   node --test scripts/test-matterport-link.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { downloadMatterport, damTextures, MatterportError, modelIdOf } from './worker/matterport-link.mjs';

const id = 'MD4iVby1G8k';
const cdn = 'https://cdn-2.matterport.com/models/abc/assets';
// A DAM with one chunk whose material names texture 000, in the layout web_archive.py reads.
const field = (number, bytes) => Buffer.concat([Buffer.from([number * 8 + 2, bytes.length]), bytes]);
const dam = field(1, Buffer.concat([field(1, Buffer.alloc(0)), field(4, Buffer.from('abc_50k_000.jpg'))]));

/** Matterport as the downloader sees it: the model graph, signed CDN addresses, and what each request was. */
function matterport({ signature = () => 'fresh', skybox = `${cdn}/pan/2k/~/<sweep>_skybox<face>.jpg`, model = true, mediaHost = 'cdn-2.matterport.com', expireOnce = false } = {}) {
  const requests = [];
  let reads = 0, expired = !expireOnce;
  const signed = url => `${url}?t=${signature(reads)}`;
  const graph = body => {
    if (body.operationName === 'GetMattertags') return { data: { model: { id, mattertags: [
      { id: 'tag1', label: 'Credits', enabled: true, mediaType: 'photo', media: `https://${mediaHost}/apifs/models/${id}/images/credits.jpg`, anchorPosition: { x: 1, y: 2, z: 1 } },
      { id: 'tag2', label: 'Elsewhere', enabled: true, mediaType: 'photo', media: 'https://example.com/photo.jpg', anchorPosition: { x: 0, y: 0, z: 1 } }] } } };
    reads++;
    if (!model) return { data: { root: null, model: null }, errors: [{ message: 'Not Found' }] };
    const pano = sweep => ({ sweepUuid: sweep, skyboxes: [{ resolution: 'high', status: 'available', urlTemplate: signed(`${cdn}/pan/high/~/${sweep}_skybox<face>.jpg`) },
      { resolution: '2k', status: 'available', urlTemplate: signed(skybox.replace('<sweep>', sweep)) }, { resolution: '4k', status: 'locked' }] });
    return { data: { root: { id, name: 'Great Pyramid', image: { url: signed(`https://cdn-2.matterport.com/apifs/models/${id}/images/cover.jpg`) } },
      model: { id, rootModelId: id, locations: [{ id: 'a', index: 0, pano: pano('s1') }, { id: 'b', index: 1, pano: pano('s2') }],
        assets: { meshes: [{ id: 'm', status: 'available', format: 'dam', resolution: '50k', url: signed(`${cdn}/abc_50k.dam`) }],
          textures: [{ status: 'available', quality: 'high', resolution: '50k', urlTemplate: signed(`${cdn}/~/abc_50k_texture_jpg_high/abc_50k_<texture>.jpg`) }] } } } };
  };
  const fetch = async (url, init = {}) => {
    requests.push({ url, method: init.method ?? 'GET', redirect: init.redirect });
    const { hostname, pathname, search } = new URL(url);
    if (pathname === '/api/mp/models/graph') return Response.json(graph(JSON.parse(init.body)));
    if (pathname.startsWith('/redirect')) return new Response(null, { status: 302, headers: { location: 'https://evil.example/face.jpg' } });
    if (!hostname.endsWith('matterport.com')) return new Response('elsewhere');
    // The first face asked for answers 410, as an expired signature does, until the graph is read again.
    if (!expired && pathname.endsWith('s1_skybox0.jpg')) { expired = true; return new Response('Gone', { status: 410 }); }
    // Pictures a tag shows are served without a signature; everything of the space itself is signed.
    if (!search.includes('t=') && !pathname.endsWith('credits.jpg')) return new Response('unsigned', { status: 403 });
    return new Response(pathname.endsWith('.dam') ? dam : `bytes of ${pathname}`, { headers: { 'content-type': 'application/octet-stream' } });
  };
  return { fetch, requests, reads: () => reads };
}

const folder = () => path.join(mkdtempSync(path.join(tmpdir(), 'matterport-link-')), 'archive');

test('links and IDs name a Matterport model; other hosts do not', () => {
  for (const link of [id, `https://my.matterport.com/show/?m=${id}&play=1`, `my.matterport.com/models/${id}`, `https://discover.matterport.com/space/${id}`]) assert.equal(modelIdOf(link), id, link);
  for (const link of [`https://evil.example/show/?m=${id}`, `https://my.matterport.com.evil.example/?m=${id}`, 'https://my.matterport.com/show/?m=short', '']) assert.equal(modelIdOf(link), undefined, link);
  assert.deepEqual(damTextures(dam), ['abc_50k_000.jpg']);
});

test('a space downloads into the archive layout web_archive.py reads, refreshing expired signatures', async () => {
  const fake = matterport({ expireOnce: true });
  const target = folder();
  const summary = await downloadMatterport(`https://my.matterport.com/show/?m=${id}`, target, { fetch: fake.fetch, concurrency: 2 });
  assert.deepEqual([summary.modelId, summary.name, summary.sweeps, summary.tags], [id, 'Great Pyramid', 2, 2]);
  // Twelve 2k faces (never the locked 4k), the mesh, its one texture, the cover and the photo of the tag Matterport hosts.
  assert.equal(summary.files, 16);
  for (const sweep of ['s1', 's2']) for (let face = 0; face < 6; face++) assert.ok(existsSync(path.join(target, `models/abc/assets/pan/2k/~/${sweep}_skybox${face}.jpg`)));
  assert.ok(!readdirSync(path.join(target, 'models/abc/assets/pan')).includes('high'), 'only the best available resolution');
  for (const file of ['models/abc/assets/abc_50k.dam', 'models/abc/assets/~/abc_50k_texture_jpg_high/abc_50k_000.jpg', `apifs/models/${id}/images/cover.jpg`,
    `apifs/models/${id}/images/credits.jpg`, 'api/mp/models/graph_GetMattertags.json', 'index.html', 'link.json']) assert.ok(existsSync(path.join(target, file)), file);
  assert.equal(fake.reads(), 2, 'the expired face sent it back to the graph once');
  assert.ok(fake.requests.every(request => new URL(request.url).hostname.endsWith('matterport.com')), 'only Matterport is contacted');
  assert.ok(!fake.requests.some(request => request.url.includes('example.com')), "a tag photo on another site is the viewer's to load, not the runner's");
  assert.ok(fake.requests.every(request => request.redirect === 'manual'), 'redirects are followed by hand, so each hop is checked');
  // index.html carries the model data the way a showcase page does.
  const page = readFileSync(path.join(target, 'index.html'), 'utf8');
  const prefetch = JSON.parse(JSON.parse(page.match(/parseJSON\(("(?:[^"\\]|\\.)*")\)/)[1]));
  assert.deepEqual([prefetch.queries.GetModelPrefetch.data.model.id, prefetch.queries.GetRootPrefetch.data.model.name], [id, 'Great Pyramid']);
  rmSync(path.dirname(target), { recursive: true, force: true });
});

test('addresses outside Matterport, redirects away from it and spaces that do not open are refused, leaving nothing behind', async () => {
  for (const [options, pattern] of [
    [{ skybox: 'https://evil.example/<sweep>_skybox<face>.jpg' }, /Refusing to contact evil\.example/],
    [{ skybox: `https://cdn-2.matterport.com/redirect/<sweep><face>.jpg` }, /Refusing to contact evil\.example/],
    [{ model: false }, /did not open/]]) {
    const target = folder();
    await assert.rejects(downloadMatterport(id, target, { fetch: matterport(options).fetch }), pattern);
    assert.deepEqual(readdirSync(path.dirname(target)), [], 'a failed download leaves no archive');
    rmSync(path.dirname(target), { recursive: true, force: true });
  }
  await assert.rejects(downloadMatterport('https://example.com/tour', folder(), { fetch: matterport().fetch }), error => error instanceof MatterportError && error.kind === 'missing');
});

test('a Matterport that asks for a pause gets it before the request is made again', async () => {
  const fake = matterport();
  let refused = 0;
  const fetch = async (url, init) => new URL(url).pathname === '/api/mp/models/graph' && !refused++
    ? new Response('Too many requests', { status: 429, headers: { 'retry-after': '2' } }) : fake.fetch(url, init);
  const target = folder();
  const started = Date.now();
  const summary = await downloadMatterport(id, target, { fetch });
  assert.ok(Date.now() - started >= 2000, 'it waited as long as Matterport asked');
  assert.equal(summary.sweeps, 2);
  await assert.rejects(downloadMatterport(id, folder(), { minutes: 0.01,
    fetch: async () => new Response('Too many requests', { status: 429, headers: { 'retry-after': '60' } }) }),
    error => error instanceof MatterportError && error.kind === 'network' && /asked for a pause/.test(error.message), 'a pause longer than the time left gives the job back');
  rmSync(path.dirname(target), { recursive: true, force: true });
});

test('a space larger than the limit stops with a reason the customer can read', async () => {
  const target = folder();
  await assert.rejects(downloadMatterport(id, target, { fetch: matterport().fetch, maxBytes: 100 }),
    error => error instanceof MatterportError && error.kind === 'unsupported' && /larger than one space can hold/.test(error.message));
  rmSync(path.dirname(target), { recursive: true, force: true });
});
