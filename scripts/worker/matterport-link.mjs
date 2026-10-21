#!/usr/bin/env node
// Downloads a Matterport space from its showcase link into a folder laid out like a matterport-dl archive,
// which scripts/matterport/web_archive.py converts: index.html with the showcase's model data, every 360 photo
// at its best available skybox resolution, the 50k DAM mesh with its textures, the space's cover picture, and
// its Mattertags with the photos Matterport hosts for them. The processing runner calls it before the agent
// starts, because the agent's sandbox has no network. Only Matterport's own hosts are contacted, over https,
// within limits on size, file count and time.
//
// The model data comes from Matterport's model graph, asked the way the showcase asks for its prefetch (the
// default view, sweeps tagged "showcase"), and is written into index.html as the showcase page carries it. The
// page itself sits behind a bot check that turns away scripts at random; the graph does not.
//   node scripts/worker/matterport-link.mjs <link or model ID> <folder>
import { createWriteStream, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

/** Matterport's showcase, API and CDNs; nothing else is ever contacted. */
export const allowedHost = host => /(^|\.)matterport\.com$/i.test(host);
const ranks = { low: 256, 512: 512, high: 1024, '1k': 1024, '2k': 2048, '4k': 4096 };
const modelQuery = `query GetModelForImport($modelId: ID!) {
  root: model(id: $modelId, view: root) { id name image { url } }
  model(id: $modelId, view: default) {
    id rootModelId
    assets { meshes { id status filename format resolution url } textures { id status format resolution quality urlTemplate } }
    locations(tags: ["showcase"]) { id index floor { id } room { id } neighbors tags position { x y z }
      pano { id sweepUuid label placement source position { x y z } rotation { x y z w } resolutions skyboxes { resolution status urlTemplate } } }
  }
}`;
const tagQuery = `query GetMattertags($modelId: ID!) { model(id: $modelId) { id mattertags(includeDisabled: false) {
  id type label description color enabled media mediaType anchorPosition { x y z } stemNormal { x y z } stemLength stemEnabled floor { id } } } }`;

/** `kind` is "missing" or "unsupported" for what the customer can fix, "network" for trouble worth retrying later. */
export class MatterportError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

export function modelIdOf(link) {
  const text = String(link ?? '').trim();
  if (/^[A-Za-z0-9]{11}$/.test(text)) return text;
  let url;
  try { url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`); } catch { return undefined; }
  if (!allowedHost(url.hostname)) return undefined;
  const id = url.searchParams.get('m') ?? url.pathname.match(/\/(?:models|space)\/([A-Za-z0-9]{11})(?:\/|$)/)?.[1];
  return /^[A-Za-z0-9]{11}$/.test(id ?? '') ? id : undefined;
}

/** index.html as a showcase page carries its model data, which is all web_archive.py reads of it. */
export function showcasePage(model, root) {
  const prefetch = { queries: { GetModelPrefetch: { data: { model } }, GetRootPrefetch: { data: { model: root } } } };
  return '<!DOCTYPE html><html><head><script charset="utf-8">\n    function parseJSON(data) { return window.JSON && window.JSON.parse ? window.JSON.parse( data ) : {}; }\n'
    + `    window.MP_PREFETCHED_MODELDATA = parseJSON(${JSON.stringify(JSON.stringify(prefetch)).replaceAll('<', '\\u003c')});\n</script></head><body></body></html>\n`;
}

function varint(data, at) {
  let value = 0;
  for (let shift = 0; shift < 49; shift += 7) {
    if (at >= data.length) throw new Error('Truncated DAM');
    const byte = data[at++];
    value += (byte & 127) * 2 ** shift;
    if (byte < 128) return [value, at];
  }
  throw new Error('Invalid DAM varint');
}

function* fields(data) {
  for (let at = 0; at < data.length;) {
    let tag, value;
    [tag, at] = varint(data, at);
    const wire = tag & 7;
    if (wire === 0) [value, at] = varint(data, at);
    else if (wire === 1 || wire === 5) { value = data.subarray(at, at + (wire === 1 ? 8 : 4)); at += wire === 1 ? 8 : 4; }
    else if (wire === 2) { let size; [size, at] = varint(data, at); value = data.subarray(at, at + size); at += size; }
    else throw new Error(`Unsupported DAM wire type ${wire}`);
    if (at > data.length) throw new Error('Truncated DAM');
    yield [Math.floor(tag / 8), wire, value];
  }
}

/** The texture files a DAM's chunks name (field 4 of each chunk), as web_archive.py reads them. */
export function damTextures(data) {
  const names = new Set();
  for (const [number, wire, chunk] of fields(data)) {
    if (number !== 1 || wire !== 2) continue;
    for (const [part, partWire, value] of fields(chunk)) if (part === 4 && partWire === 2) names.add(Buffer.from(value).toString('utf8'));
  }
  return [...names];
}

/** The archive path matterport-dl uses for an asset: its URL path, verbatim. */
function archivePath(folder, url) {
  const relative = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, '');
  if (!relative || relative.split('/').some(part => part === '..' || part === '.' || part === '')) throw new Error(`Unexpected asset path: ${relative}`);
  const target = path.resolve(folder, relative);
  if (!target.startsWith(path.resolve(folder) + path.sep)) throw new Error(`Asset escapes the archive: ${relative}`);
  return target;
}

/**
 * Downloads the space into `folder`, which must not exist yet, and returns what it holds. `fetch` and `base` are
 * for tests. Everything is written under a temporary name first, so a failed download leaves no archive.
 */
export async function downloadMatterport(link, folder, { fetch = globalThis.fetch, log = () => {}, base = 'https://my.matterport.com',
  maxBytes = 20e9, maxFiles = 20000, fileBytes = 400e6, minutes = 60, concurrency = 6 } = {}) {
  const modelId = modelIdOf(link);
  if (!modelId) throw new MatterportError('missing', 'The link is not a Matterport space link.');
  const deadline = Date.now() + minutes * 60_000;
  let bytes = 0, files = 0;

  /** One request to an allowed https host, following up to three redirects that stay on allowed hosts. */
  async function request(url, init = {}, attempt = 0) {
    for (let hops = 0; ; hops++) {
      const target = new URL(url);
      // `base` is Matterport's showcase, or a test's stand-in for it.
      if (!url.startsWith(`${base}/`) && (target.protocol !== 'https:' || !allowedHost(target.hostname))) throw new Error(`Refusing to contact ${target.host}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new MatterportError('network', 'Downloading the Matterport space took too long.');
      let response;
      try { response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(Math.min(left, 180_000)), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Spacery)', ...init.headers } }); }
      catch (error) {
        if (attempt < 3) { await new Promise(resolve => setTimeout(resolve, 1000 * 4 ** attempt)); return request(url, init, attempt + 1); }
        throw new MatterportError('network', `Matterport did not answer: ${error.message}`);
      }
      if (response.status >= 300 && response.status < 400 && response.headers.get('location') && hops < 3) {
        await response.body?.cancel();
        url = new URL(response.headers.get('location'), url).href;
        continue;
      }
      if ((response.status >= 500 || response.status === 429) && attempt < 3) {
        await response.body?.cancel();
        await new Promise(resolve => setTimeout(resolve, 1000 * 4 ** attempt));
        return request(url, init, attempt + 1);
      }
      return response;
    }
  }

  /** One question to the model graph; GraphQL answers 200 even when the model is missing, with errors instead of data. */
  async function graph(operationName, query) {
    const response = await request(`${base}/api/mp/models/graph`, { method: 'POST', body: JSON.stringify({ operationName, variables: { modelId }, query }),
      headers: { 'Content-Type': 'application/json', 'x-matterport-application-name': 'showcase' } });
    const body = Buffer.from(await response.arrayBuffer());
    if (response.status !== 200) throw new MatterportError('network', `Matterport answered ${response.status}.`);
    if (body.length > 64e6) throw new MatterportError('unsupported', 'This Matterport space is described by more data than one space can hold.');
    try { return JSON.parse(body.toString('utf8')); } catch { throw new MatterportError('network', 'Matterport sent an unreadable answer.'); }
  }

  const staging = `${folder}.partial-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    const read = async () => {
      const answer = await graph('GetModelForImport', modelQuery);
      const model = answer?.data?.model, root = answer?.data?.root;
      if (!model || model.id !== modelId) throw new MatterportError('missing', 'This Matterport space did not open. It may be private, need a password, or no longer exist.');
      if (!root || root.id !== model.id) throw new MatterportError('unsupported', 'This link opens a combined space made of several Matterport spaces; bring over each one by its own link.');
      return { model, root };
    };
    let { model, root } = await read();
    const locations = model.locations ?? [];
    if (!locations.length) throw new MatterportError('unsupported', 'This Matterport space has no 360 photos.');

    /** Every asset to fetch, keyed by its archive path, from the current page's signed addresses. */
    const assets = () => {
      const wanted = new Map();
      for (const location of locations) {
        const fresh = model.locations.find(item => item.id === location.id) ?? location;
        const boxes = (fresh.pano?.skyboxes ?? []).filter(box => box.status === 'available' && box.urlTemplate && ranks[box.resolution]);
        if (!boxes.length) throw new MatterportError('unsupported', 'A 360 photo of this Matterport space has no available image.');
        const best = boxes.reduce((top, box) => ranks[box.resolution] > ranks[top.resolution] ? box : top);
        for (let face = 0; face < 6; face++) {
          const url = best.urlTemplate.replaceAll('<face>', String(face));
          wanted.set(archivePath(staging, url), url);
        }
      }
      return wanted;
    };

    async function save(url, target, limit = fileBytes) {
      if (++files > maxFiles) throw new MatterportError('unsupported', 'This Matterport space has more files than one space can hold.');
      const response = await request(url);
      // An expired signature is refused with 410 (or 401/403).
      if ([401, 403, 410].includes(response.status)) { files--; await response.body?.cancel(); return 'expired'; }
      if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw new MatterportError('network', `Matterport answered ${response.status} for a file.`); }
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > limit || bytes + declared > maxBytes) throw new MatterportError('unsupported', 'This Matterport space is larger than one space can hold.');
      mkdirSync(path.dirname(target), { recursive: true });
      let size = 0;
      const counted = Readable.fromWeb(response.body).on('data', chunk => {
        size += chunk.length;
        if (size > limit || bytes + size > maxBytes) counted.destroy(new MatterportError('unsupported', 'This Matterport space is larger than one space can hold.'));
      });
      await pipeline(counted, createWriteStream(target));
      bytes += size;
      return 'saved';
    }

    /**
     * Downloads every asset a few at a time. The graph signs addresses for five minutes, so they are read again
     * every two and a half, and once more for any Matterport turns away as expired. `renew` reads fresh ones.
     */
    async function saveAll(wanted, renew) {
      let urls = wanted, read = Date.now(), refreshing, pending = [...wanted.keys()], done = 0;
      const refresh = () => refreshing ??= renew().then(fresh => { urls = fresh; read = Date.now(); }).finally(() => { refreshing = undefined; });
      for (let round = 0; pending.length; round++) {
        const expired = [];
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
          while (next < pending.length) {
            if (Date.now() - read > 150_000) await refresh();
            const target = pending[next++], url = urls.get(target);
            if (!url) throw new MatterportError('network', 'Matterport no longer lists a file of this space.');
            if (await save(url, target) === 'expired') expired.push(target);
            else if (++done % 200 === 0) log(`${done} of ${wanted.size} files, ${Math.round(bytes / 1e6)} MB`);
          }
        }));
        if (!expired.length) return;
        if (round >= 2) throw new MatterportError('network', 'Matterport refused files of this space.');
        await refresh();
        pending = expired;
      }
    }
    const renewPage = async () => { ({ model, root } = await read()); };

    log(`downloading ${locations.length} 360 photos from Matterport`);
    await saveAll(assets(), async () => { await renewPage(); return assets(); });

    const meshes = (model.assets?.meshes ?? []).filter(mesh => mesh.status === 'available' && mesh.format === 'dam' && mesh.resolution === '50k' && mesh.url);
    if (meshes.length !== 1) throw new MatterportError('unsupported', 'This Matterport space has no 50k dollhouse mesh to bring over.');
    const meshTarget = archivePath(staging, meshes[0].url);
    await saveAll(new Map([[meshTarget, meshes[0].url]]), async () => {
      await renewPage();
      const mesh = (model.assets?.meshes ?? []).find(item => item.id === meshes[0].id);
      return new Map(mesh ? [[meshTarget, mesh.url]] : []);
    });
    const textures = () => {
      const template = (model.assets?.textures ?? []).find(item => item.status === 'available' && item.quality === 'high' && item.resolution === '50k')?.urlTemplate;
      if (!template) throw new MatterportError('unsupported', 'This Matterport space has no dollhouse textures to bring over.');
      return new Map(damTextures(readFileSync(meshTarget)).map(name => {
        const index = name.match(/_(\d+)\.[^.]+$/)?.[1];
        if (!index) throw new MatterportError('unsupported', 'The dollhouse mesh names its textures in an unknown way.');
        const url = template.replaceAll('<texture>', index);
        return [archivePath(staging, url), url];
      }));
    };
    log('downloading the dollhouse mesh and its textures');
    await saveAll(textures(), async () => { await renewPage(); return textures(); });

    // The space's cover picture becomes the preview; a failure here costs only the picture.
    const cover = root.image?.url;
    if (cover && allowedHost(new URL(cover).hostname)) {
      try { if (await save(cover, archivePath(staging, cover), 30e6) !== 'saved') log('the cover picture was refused'); }
      catch (error) { log(`cover picture skipped: ${error.message}`); }
    }

    // Mattertags come from the model graph, as the showcase reads them. A space without them is still a space.
    let tags = [];
    try {
      tags = (await graph('GetMattertags', tagQuery))?.data?.model?.mattertags ?? [];
      if (!Array.isArray(tags)) tags = [];
      const target = path.join(staging, 'api/mp/models/graph_GetMattertags.json');
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify({ data: { model: { id: modelId, mattertags: tags } } }, null, 1));
      for (const tag of tags) {
        if (tag?.mediaType !== 'photo' || typeof tag.media !== 'string') continue;
        let url;
        try { url = new URL(tag.media); } catch { continue; }
        if (url.protocol !== 'https:' || !allowedHost(url.hostname)) continue;
        try { if (await save(url.href, archivePath(staging, url.href), 30e6) !== 'saved') log('a tag photo was refused'); }
        catch (error) { log(`tag photo skipped: ${error.message}`); }
      }
    } catch (error) {
      if (error instanceof MatterportError && error.kind === 'unsupported') throw error;
      log(`Mattertags skipped: ${error.message}`);
    }

    // The model data as last read, so its signed addresses match the files.
    writeFileSync(path.join(staging, 'index.html'), showcasePage(model, root));
    const summary = { modelId, url: `https://my.matterport.com/show/?m=${modelId}`, name: root.name ?? '', sweeps: locations.length,
      tags: tags.length, files, bytes, downloaded: new Date().toISOString() };
    writeFileSync(path.join(staging, 'link.json'), JSON.stringify(summary, null, 2) + '\n');
    rmSync(folder, { recursive: true, force: true });
    renameSync(staging, folder);
    log(`downloaded ${files} files (${Math.round(bytes / 1e6)} MB) from Matterport`);
    return summary;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [link, folder] = process.argv.slice(2);
  if (!link || !folder) { console.error('Usage: matterport-link.mjs <link or model ID> <folder>'); process.exit(2); }
  downloadMatterport(link, path.resolve(folder), { log: line => console.error(line) })
    .then(summary => console.log(JSON.stringify(summary, null, 2)))
    .catch(error => { console.error(`${error.kind ?? 'error'}: ${error.message}`); process.exit(1); });
}
