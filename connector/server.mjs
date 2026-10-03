#!/usr/bin/env node
// Agent connector: a local MCP server (stdio) that lets a person's own agent (Claude, Codex,
// Antigravity and the like) link to their hosting account, pay through Stripe Checkout in
// their browser, and upload capture files straight from their computer. Uploads run in a
// detached process that resumes after interruptions and submits the space when done, so a
// 40 GB scan does not depend on the chat staying open. No dependencies beyond Node 18.
//
//   node server.mjs                     MCP server on stdin/stdout
//   node server.mjs call <tool> [json]  one tool from a shell, for agents that cannot load MCP servers yet
//   node server.mjs upload <space>      the background uploader (started by the server)
//
// The hosting site comes from brand.json beside this file (written by build.mjs) or from
// SPHR_URL and SPHR_NAME. State lives in ~/.<slug> (SPHR_CONNECTOR_HOME overrides it).
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const here = path.dirname(self);
const packaged = readJsonFile(path.join(here, 'brand.json')) ?? {};
const version = readJsonFile(path.join(here, 'package.json'))?.version ?? '0.0.0';
const brand = {
  name: process.env.SPHR_NAME || packaged.name || 'SPHR',
  url: (process.env.SPHR_URL || packaged.url || '').replace(/\/+$/, ''),
  slug: packaged.slug || 'sphr'
};
const home = process.env.SPHR_CONNECTOR_HOME || path.join(os.homedir(), `.${brand.slug}`);
const files = {
  credentials: path.join(home, 'credentials.json'),
  pendingLink: path.join(home, 'pending-link.json'),
  jobs: path.join(home, 'uploads'),
  logs: path.join(home, 'logs')
};
const toolWait = 50000; // below the 60 s tool timeout most clients use
const parallelFiles = 3;
const maxFiles = 2000;

// ---------------------------------------------------------------------------------------------
// Small helpers

function readJsonFile(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; }
}

/** Atomic write, private to this user: credentials and job files hold tokens and upload URLs. */
function writeJsonFile(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temporary, file);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function formatBytes(bytes) {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return unit ? `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}` : `${bytes} bytes`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'unknown';
  if (seconds < 90) return `${Math.round(seconds)} seconds`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} minutes`;
  return `${(seconds / 3600).toFixed(1)} hours`;
}

function formatMoney(amount, currency) {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(amount / 100); }
  catch { return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`; }
}

/** Opens a page in the person's default browser. */
function openBrowser(url) {
  if (process.env.SPHR_CONNECTOR_NO_BROWSER === '1') return false;
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}

class Problem extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data; }
}

// ---------------------------------------------------------------------------------------------
// Account link and API

function credentials() {
  const saved = readJsonFile(files.credentials)?.[brand.url];
  return saved?.token ? saved : undefined;
}

function saveCredentials(value) {
  const all = readJsonFile(files.credentials) ?? {};
  if (value) all[brand.url] = value; else delete all[brand.url];
  writeJsonFile(files.credentials, all);
}

function requireSite() {
  if (!brand.url) throw new Problem('No hosting site is configured. Set SPHR_URL to the address of the SPHR site, for example https://app.example.com.');
}

async function api(route, { method = 'GET', body, auth = true, timeout = 30000 } = {}) {
  requireSite();
  const saved = auth ? credentials() : undefined;
  if (auth && !saved) throw new Problem(`This agent is not linked to a ${brand.name} account yet. Call link_account first.`, 401);
  const payload = method === 'GET' || method === 'DELETE' ? body : body ?? {};
  let response;
  try {
    response = await fetch(brand.url + route, { method, signal: AbortSignal.timeout(timeout), headers: {
      'User-Agent': `sphr-connector/${version}`, Accept: 'application/json',
      ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(saved ? { Authorization: `Bearer ${saved.token}` } : {}) },
      body: payload !== undefined ? JSON.stringify(payload) : undefined });
  } catch (error) {
    throw new Problem(`${brand.name} could not be reached (${error.name === 'TimeoutError' ? 'timed out' : error.message}). Check the internet connection and try again.`);
  }
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && saved) {
    saveCredentials(undefined);
    throw new Problem(`This agent is no longer linked to ${saved.email}. Call link_account to link it again.`, 401, data);
  }
  if (!response.ok) throw new Problem(data.error || `${brand.name} answered HTTP ${response.status}.`, response.status, data);
  return data;
}

let clientInfo = { name: '', version: '' };

/** How the account page names this agent, for example "Claude on studio-mac". */
function clientLabel() {
  const known = { 'claude-ai': 'Claude', 'claude-code': 'Claude Code', 'codex-mcp-client': 'Codex', codex: 'Codex', 'codex-cli': 'Codex',
    antigravity: 'Antigravity', 'gemini-cli-mcp-client': 'Gemini CLI', cursor: 'Cursor', 'cursor-vscode': 'Cursor', 'Visual Studio Code': 'VS Code', grok: 'Grok' };
  const raw = clientInfo.name || 'An agent';
  const name = (known[raw] ?? known[raw.toLowerCase()] ?? raw.replace(/[-_]+/g, ' ').replace(/\b(mcp|client)\b/gi, '').trim()) || 'An agent';
  const host = os.hostname().replace(/\.(local|lan|home)$/i, '');
  return `${name} on ${host}`.slice(0, 80);
}

// ---------------------------------------------------------------------------------------------
// Local files

const kinds = [
  ['scan', 'laser scan or point cloud', ['e57', 'las', 'laz', 'pts', 'ptx', 'xyz', 'rcp', 'rcs', 'fls', 'lsproj', 'pcd', 'bin']],
  ['splat', 'Gaussian splat', ['splat', 'ksplat', 'spz', 'sog']],
  ['mesh', '3D mesh', ['obj', 'mtl', 'glb', 'gltf', 'fbx', 'usdz', 'usd', 'dae', 'stl', '3ds', 'abc']],
  ['video', 'video', ['mp4', 'mov', 'm4v', 'insv', '360', 'avi', 'mkv', 'webm']],
  ['photo', 'photo', ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'tif', 'tiff', 'dng', 'insp', 'exr', 'hdr']],
  ['archive', 'archive (for example a Matterport export)', ['zip', 'tar', 'gz', 'tgz', '7z']],
  ['texture', 'texture or sidecar', ['json', 'xml', 'txt', 'csv', 'ktx2', 'basis', 'nvm', 'db', 'yaml', 'yml']]
];
const types = { e57: 'application/octet-stream', mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', tif: 'image/tiff', tiff: 'image/tiff', glb: 'model/gltf-binary',
  gltf: 'model/gltf+json', obj: 'model/obj', stl: 'model/stl', usdz: 'model/vnd.usdz+zip', zip: 'application/zip', json: 'application/json' };
const ignored = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.localized']);

function extension(name) {
  return path.extname(name).slice(1).toLowerCase();
}

/** Width and height from a JPEG, PNG or WebP header, to tell 360 photos (2:1) from ordinary ones. */
async function imageSize(file) {
  let handle;
  try {
    handle = await open(file, 'r');
    const head = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const bytes = head.subarray(0, bytesRead);
    if (bytes.readUInt32BE(0) === 0x89504e47) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
      const chunk = bytes.toString('latin1', 12, 16);
      if (chunk === 'VP8X') return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
      if (chunk === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const bits = bytes.readUInt32LE(21);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
      }
      return undefined;
    }
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
    for (let at = 2; at + 9 < bytes.length;) {
      if (bytes[at] !== 0xff) { at++; continue; }
      const marker = bytes[at + 1];
      const length = bytes.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
      at += 2 + length;
    }
  } catch { /* unreadable headers only lose the 360 hint */ }
  finally { await handle?.close(); }
  return undefined;
}

/** A PLY file is a Gaussian splat when its vertices carry spherical harmonics, otherwise a point cloud or mesh. */
async function plyKind(file) {
  let handle;
  try {
    handle = await open(file, 'r');
    const head = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const text = head.subarray(0, bytesRead).toString('latin1');
    if (/property \w+ f_dc_0|property \w+ scale_0/.test(text)) return 'splat';
    if (/element face [1-9]/.test(text)) return 'mesh';
    return 'scan';
  } catch { return 'scan'; }
  finally { await handle?.close(); }
}

async function describeFile(file, size) {
  const ext = extension(file);
  if (ext === 'ply') return { kind: await plyKind(file) };
  const kind = kinds.find(([, , list]) => list.includes(ext))?.[0] ?? 'other';
  if (kind === 'photo' && ['jpg', 'jpeg', 'png', 'webp'].includes(ext) && size > 0) {
    const dimensions = await imageSize(file);
    if (dimensions && Math.abs(dimensions.width / dimensions.height - 2) < 0.02) return { kind: 'photo360', dimensions };
    return { kind, dimensions };
  }
  return { kind };
}

/** Every file under the given paths, skipping hidden and system files. */
async function collectFiles(paths) {
  if (!Array.isArray(paths) || !paths.length) throw new Problem('Give one or more file or folder paths.');
  const found = [], missing = [], seen = new Set();
  async function walk(target, depth) {
    let info;
    try { info = await stat(target); } catch { missing.push(target); return; }
    if (info.isDirectory()) {
      if (depth > 8) return;
      const entries = await readdir(target, { withFileTypes: true }).catch(() => []);
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || ignored.has(entry.name.toLowerCase())) continue;
        await walk(path.join(target, entry.name), depth + 1);
        if (found.length > maxFiles) return;
      }
    } else if (info.isFile() && !seen.has(target)) {
      seen.add(target);
      found.push({ path: target, name: path.basename(target), size: info.size, mtimeMs: info.mtimeMs });
    }
  }
  for (const item of paths) {
    const target = path.resolve(String(item).replace(/^~(?=$|[\\/])/, os.homedir()));
    await walk(target, 0);
  }
  return { found, missing };
}

function suggestTitle(paths, found) {
  const first = path.resolve(String(paths[0]).replace(/^~(?=$|[\\/])/, os.homedir()));
  const base = found.length === 1 ? path.parse(found[0].name).name : path.basename(first);
  return base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\w/, letter => letter.toUpperCase()).slice(0, 200) || 'New space';
}

// ---------------------------------------------------------------------------------------------
// Upload jobs (shared by the server, which starts them, and the detached uploader)

const jobFile = space => path.join(files.jobs, `${space}.json`);
const readJob = space => readJsonFile(jobFile(space));
const saveJob = job => writeJsonFile(jobFile(job.spaceId), { ...job, updated: new Date().toISOString() });

function processAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

const jobRunning = job => Boolean(job && ['waiting', 'uploading', 'submitting'].includes(job.status) && processAlive(job.pid));

function jobProgress(job) {
  const total = job.files.reduce((sum, file) => sum + file.size, 0);
  const sent = job.files.reduce((sum, file) => sum + (file.done ? file.size : file.sent ?? 0), 0);
  const done = job.files.filter(file => file.done).length;
  return { total, sent, done, count: job.files.length, percent: total ? Math.floor(sent / total * 1000) / 10 : 100 };
}

function startUploader(space) {
  mkdirSync(files.logs, { recursive: true, mode: 0o700 });
  const log = openSync(path.join(files.logs, `${space}.log`), 'a', 0o600);
  const child = spawn(process.execPath, [self, 'upload', space], { detached: true, windowsHide: true, stdio: ['ignore', log, log],
    env: { ...process.env, SPHR_URL: brand.url, SPHR_NAME: brand.name, SPHR_CONNECTOR_HOME: home } });
  child.unref();
  closeSync(log);
  // Keeps a Mac awake until the upload finishes.
  if (process.platform === 'darwin' && child.pid) {
    try { spawn('caffeinate', ['-i', '-w', String(child.pid)], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch { /* optional */ }
  }
  return child.pid;
}

/** Sends one file in the chunk size the server asks for, resuming from what storage already holds. */
async function uploadFile(job, file, persist) {
  const current = await stat(file.path).catch(() => undefined);
  if (!current) throw new Problem(`${file.name} is no longer at ${file.path}.`);
  if (current.size !== file.size || Math.abs(current.mtimeMs - file.mtimeMs) > 1) throw new Problem(`${file.name} changed after the upload started. Start the upload again.`);
  let restarts = 0;
  for (;;) {
    if (!file.uploadId) {
      const created = await api(`/api/account/spaces/${job.spaceId}/uploads`, { method: 'POST',
        body: { name: file.name, size: file.size, type: types[extension(file.name)] ?? 'application/octet-stream' } });
      Object.assign(file, { uploadId: created.upload.id, url: new URL(created.url, brand.url).href, chunkSize: created.chunkSize, sent: 0 });
      persist(true);
    } else {
      file.sent = (await api(`/api/account/uploads/${file.uploadId}`)).offset ?? 0;
    }
    const result = await sendChunks(file, persist);
    if (result === 'done') break;
    // The storage session expired (they last a week); start this file again once.
    if (++restarts > 1) throw new Problem(`${file.name} could not be uploaded because storage refused the session.`);
    await api(`/api/account/uploads/${file.uploadId}`, { method: 'DELETE' }).catch(() => {});
    delete file.uploadId;
  }
  await api(`/api/account/uploads/${file.uploadId}/complete`, { method: 'POST' });
  file.done = true;
  file.sent = file.size;
  persist(true);
}

async function sendChunks(file, persist) {
  const sameSite = new URL(file.url).origin === new URL(brand.url).origin;
  const token = credentials()?.token;
  const handle = await open(file.path, 'r');
  let failures = 0;
  try {
    while (file.sent < file.size || file.size === 0) {
      const start = file.sent;
      const end = Math.min(start + file.chunkSize, file.size) - 1;
      const chunk = Buffer.alloc(Math.max(0, end - start + 1));
      if (chunk.length) await handle.read(chunk, 0, chunk.length, start);
      let response;
      try {
        response = await fetch(file.url, { method: 'PUT', body: chunk, signal: AbortSignal.timeout(180000), headers: {
          'Content-Range': file.size ? `bytes ${start}-${end}/${file.size}` : 'bytes */0',
          // Local storage is served by the site itself; a storage bucket's session URL needs no token and must never see one.
          ...(sameSite && token ? { Authorization: `Bearer ${token}` } : {}) } });
      } catch { response = undefined; }
      if (response && (response.status === 200 || response.status === 201)) { file.sent = file.size; return 'done'; }
      if (response?.status === 308) {
        const range = response.headers.get('range')?.match(/bytes=0-(\d+)/);
        const body = range ? undefined : await response.json().catch(() => undefined);
        file.sent = range ? Number(range[1]) + 1 : body?.offset ?? 0;
        failures = 0;
        persist(false);
        continue;
      }
      if (response && [404, 410].includes(response.status)) return 'expired';
      if (++failures > 10) throw new Problem(`${file.name} kept failing to upload (${response ? `HTTP ${response.status}` : 'network error'}).`);
      await sleep(Math.min(60000, 1000 * 2 ** failures));
      file.sent = (await api(`/api/account/uploads/${file.uploadId}`).catch(() => ({ offset: file.sent }))).offset ?? file.sent;
    }
    return 'done';
  } finally { await handle.close(); }
}

/** The detached uploader: every file, three at a time, then the submission. */
async function runUploader(space) {
  let job = readJob(space);
  if (!job) return;
  if (job.pid && job.pid !== process.pid && processAlive(job.pid)) return;
  job = { ...job, pid: process.pid, status: 'uploading', error: null, started: job.started ?? new Date().toISOString() };
  saveJob(job);
  let lastWrite = 0, sample = { at: Date.now(), sent: jobProgress(job).sent };
  const persist = force => {
    const now = Date.now();
    if (!force && now - lastWrite < 1000) return;
    const sent = jobProgress(job).sent;
    if (now - sample.at >= 5000) {
      const rate = (sent - sample.sent) / ((now - sample.at) / 1000);
      job.rate = job.rate ? job.rate * 0.6 + rate * 0.4 : rate;
      sample = { at: now, sent };
    }
    lastWrite = now;
    saveJob(job);
  };
  const log = message => console.log(`${new Date().toISOString()} ${message}`);
  try {
    const queue = job.files.filter(file => !file.done);
    log(`Uploading ${queue.length} files to space ${space}`);
    let failure;
    await Promise.all(Array.from({ length: Math.min(parallelFiles, queue.length) }, async () => {
      while (queue.length && !failure) {
        const file = queue.shift();
        try { await uploadFile(job, file, persist); log(`Uploaded ${file.name}`); }
        catch (error) { failure ??= error; }
      }
    }));
    if (failure) throw failure;
    if (job.submit) {
      job.status = 'submitting';
      persist(true);
      await api(`/api/account/spaces/${space}/submit`, { method: 'POST', body: { ...(job.notes ? { notes: job.notes } : {}), ...(job.output ? { output: job.output } : {}) } });
      job.status = 'submitted';
      job.submitted = new Date().toISOString();
      log('Submitted for processing');
    } else job.status = 'uploaded';
  } catch (error) {
    job.status = 'failed';
    job.error = error.message;
    log(`Failed: ${error.message}`);
  }
  job.pid = null;
  saveJob(job);
}

// ---------------------------------------------------------------------------------------------
// Tools

const spaceId = { type: 'string', description: 'The space ID (12 hexadecimal characters) from create_space or space_status.' };
const tourId = { type: 'string', description: 'The tour ID (12 hexadecimal characters) from create_tour or list_tours.' };
const tools = [
  {
    name: 'link_account',
    description: `Links this agent to the person's ${brand.name} account. Opens a page in their browser where they sign in (or sign up) and approve a short code; waits up to 50 seconds. Call it again to keep waiting. Never ask the person for a password.`,
    inputSchema: { type: 'object', properties: { relink: { type: 'boolean', description: 'Link again even if already linked, for example to use another account.' } } },
    run: linkAccount
  },
  {
    name: 'check_files',
    description: 'Looks at capture files or folders on this computer without uploading anything: what kind of capture each file is (laser scan, E57, point cloud, Gaussian splat, 360 photo or video, mesh, photo set, archive), how many there are and their total size, with a suggested title.',
    inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths to files or folders.' } }, required: ['paths'] },
    run: checkFiles
  },
  {
    name: 'list_plans',
    description: `The ways to pay for ${brand.name} hosting, with prices, and the account's current plan. Show these to the person before the first space so they can choose.`,
    inputSchema: { type: 'object', properties: {} },
    run: listPlans
  },
  {
    name: 'create_space',
    description: 'Creates a space to upload files into. When the account is not paying for hosting yet, it opens Stripe Checkout in the browser for the plan the person chose (pay as you go when none is given); the person pays there, then call wait_for_payment. Never ask for card details.',
    inputSchema: { type: 'object', properties: {
      title: { type: 'string', description: 'Title of the space, 1 to 200 characters.' },
      plan: { type: 'string', description: 'Optional plan name or ID from list_plans, used only when payment is needed.' }
    }, required: ['title'] },
    run: createSpace
  },
  {
    name: 'wait_for_payment',
    description: 'Waits up to 50 seconds for the person to finish paying in Stripe Checkout. Call it again to keep waiting.',
    inputSchema: { type: 'object', properties: { space_id: spaceId }, required: ['space_id'] },
    run: waitForPayment
  },
  {
    name: 'upload_files',
    description: 'Uploads files or folders from this computer into a space and submits it for processing. The upload runs in the background, keeps going if this conversation ends, resumes after network interruptions and returns at once; follow it with space_status. Upload every file of one capture in one call.',
    inputSchema: { type: 'object', properties: {
      space_id: spaceId,
      paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths to files or folders.' },
      notes: { type: 'string', description: 'Optional notes for the processing team, such as what the capture is or how the tour should go (up to 2000 characters).' },
      output: { type: 'string', enum: ['splat', 'tour', 'auto'], description: 'What to build: "splat", a 3DGS (3D Gaussian splat) visitors move through freely (the default for photos, video and 360 captures); "tour", a guided tour of 360 panoramas (the default for E57 scans); or "auto" to use those defaults. Set it only when the person asks for one.' },
      submit: { type: 'boolean', description: 'Submit for processing when the upload finishes. Defaults to true; use false to add more files in another call first.' }
    }, required: ['space_id', 'paths'] },
    run: uploadFiles
  },
  {
    name: 'space_status',
    description: 'Upload progress and processing status for one space, or every space on the account with its link when ready.',
    inputSchema: { type: 'object', properties: { space_id: spaceId } },
    run: spaceStatus
  },
  {
    name: 'set_visibility',
    description: 'Makes a ready space public (anyone with the link can open it) or private (only the owner). Ask the person first.',
    inputSchema: { type: 'object', properties: { space_id: spaceId, public: { type: 'boolean' } }, required: ['space_id', 'public'] },
    run: setVisibility
  },
  {
    name: 'unlink_account',
    description: `Unlinks this agent from the ${brand.name} account and forgets its token on this computer.`,
    inputSchema: { type: 'object', properties: {} },
    run: unlinkAccount
  },
  {
    name: 'find_tour_spaces',
    description: `Spaces a guided tour or scavenger hunt can be built on: the person's own finished spaces and ${brand.name}'s public spaces (museums, temples, tombs, gardens). Search by words in the title.`,
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Words from the title, for example "pyramid" or "delphi". Empty lists the first spaces.' } } },
    run: findTourSpaces
  },
  {
    name: 'list_tours',
    description: 'The tours and scavenger hunts on the account, with their links and how many stops each has.',
    inputSchema: { type: 'object', properties: {} },
    run: listTours
  },
  {
    name: 'create_tour',
    description: 'Starts a guided tour or a scavenger hunt on a space from find_tour_spaces. It starts private and empty; fill it with draft_tour or save_tour.',
    inputSchema: { type: 'object', properties: {
      scene_id: { type: 'string', description: 'The sceneId from find_tour_spaces.' },
      kind: { type: 'string', enum: ['tour', 'hunt'], description: '"tour" for a guided tour, "hunt" for a scavenger hunt.' },
      title: { type: 'string', description: 'Optional title; defaults to the space\'s name.' }
    }, required: ['scene_id'] },
    run: createTour
  },
  {
    name: 'draft_tour',
    description: `Asks ${brand.name}'s tour agent, which can see the space's photographs, to write or rework the tour from a request in plain words: stops and their text, hidden objects and clues, library models, effects, sound, music and looks (line drawing, blueprint, film noir and more, with transitions). It places everything and saves. Takes one to five minutes; it returns at once, then call wait_for_tour.`,
    inputSchema: { type: 'object', properties: { tour_id: tourId, request: { type: 'string', description: 'What to make or change, up to 6000 characters.' } }, required: ['tour_id', 'request'] },
    run: draftTour
  },
  {
    name: 'wait_for_tour',
    description: 'Waits up to 50 seconds for a draft from draft_tour to finish, then summarizes the tour. Call it again to keep waiting.',
    inputSchema: { type: 'object', properties: { tour_id: tourId }, required: ['tour_id'] },
    run: waitForTour
  },
  {
    name: 'get_tour',
    description: 'The tour as JSON (stops, objects, effects, looks) with its revision, for editing with save_tour.',
    inputSchema: { type: 'object', properties: { tour_id: tourId }, required: ['tour_id'] },
    run: getTour
  },
  {
    name: 'save_tour',
    description: 'Saves a tour edited by hand: the experience JSON from get_tour with your changes. Objects, effects and stops keep the shapes get_tour shows; models use a url from search_models or upload_model.',
    inputSchema: { type: 'object', properties: { tour_id: tourId, experience: { type: 'object', description: 'The whole experience: version, kind, stops, objects, effects, optional look and finale.' },
      title: { type: 'string' } }, required: ['tour_id', 'experience'] },
    run: saveTour
  },
  {
    name: 'search_models',
    description: `Searches ${brand.name}'s library of ready-made 3D models (statues, amphorae, furniture, animals, buildings and props from many periods). Returns each model's id, size and url; use the url as an object's source url in save_tour, or name the models in a draft_tour request.`,
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
    run: searchModels
  },
  {
    name: 'upload_model',
    description: 'Uploads a 3D model from this computer to a tour, for example one you built in Blender (export glTF Binary .glb, meters, Y up, everything embedded, under 25 MB). Returns the url to use as an object\'s source url in save_tour.',
    inputSchema: { type: 'object', properties: { tour_id: tourId, path: { type: 'string', description: 'Absolute path to the .glb file.' } }, required: ['tour_id', 'path'] },
    run: uploadModel
  },
  {
    name: 'share_tour',
    description: 'Makes a tour public (anyone with its link can open it, never listed or indexed) or private, and optionally renames it. Ask the person first.',
    inputSchema: { type: 'object', properties: { tour_id: tourId, public: { type: 'boolean' }, title: { type: 'string' } }, required: ['tour_id'] },
    run: shareTour
  }
];

async function linkAccount({ relink = false } = {}) {
  requireSite();
  const saved = credentials();
  if (saved && !relink) {
    try {
      await api('/api/account/spaces');
      return `Already linked to the ${brand.name} account ${saved.email}.`;
    } catch (error) { if (error.status !== 401) throw error; }
  }
  if (relink && saved) await api('/api/agent/token', { method: 'DELETE' }).catch(() => {}).finally(() => saveCredentials(undefined));
  let pending = readJsonFile(files.pendingLink);
  let opened = false;
  if (!pending || pending.site !== brand.url || pending.expires < Date.now() + 15000) {
    const link = await api('/api/agent/link', { method: 'POST', body: { client: clientLabel() }, auth: false });
    pending = { site: brand.url, code: link.code, userCode: link.userCode, url: link.url, interval: link.interval, expires: Date.now() + link.expiresIn * 1000 };
    writeJsonFile(files.pendingLink, pending);
    opened = openBrowser(pending.url);
  }
  const deadline = Date.now() + toolWait;
  while (Date.now() < deadline) {
    let result;
    try { result = await api('/api/agent/token', { method: 'POST', body: { code: pending.code }, auth: false }); }
    catch (error) {
      if (error.status === 410) { rmSync(files.pendingLink, { force: true }); throw new Problem('The link code expired before it was approved. Call link_account again for a new one.'); }
      throw error;
    }
    if (result.status === 'approved') {
      saveCredentials({ token: result.token, email: result.email, linked: new Date().toISOString() });
      rmSync(files.pendingLink, { force: true });
      return [`Linked to the ${brand.name} account ${result.email}.`,
        result.emailVerified ? '' : 'The email address is not confirmed yet. Ask the person to click the link in the confirmation email before creating a space.'].filter(Boolean).join(' ');
    }
    await sleep(Math.max(2, pending.interval || 3) * 1000);
  }
  return [`Waiting for the person to approve this agent. ${opened ? 'A page opened in their browser' : 'Ask them to open ' + pending.url}`,
    `where they sign in to ${brand.name} and click Link agent. The page shows the code ${pending.userCode}, which they should check matches.`,
    `If no page opened, give them this link ${pending.url}. Call link_account again to keep waiting.`].join(' ');
}

async function checkFiles({ paths }) {
  const { found, missing } = await collectFiles(paths);
  if (!found.length) throw new Problem(missing.length ? `Nothing found at ${missing.join(', ')}.` : 'Those folders are empty.');
  const groups = new Map();
  let total = 0;
  for (const file of found.slice(0, maxFiles)) {
    const { kind, dimensions } = await describeFile(file.path, file.size);
    total += file.size;
    const group = groups.get(kind) ?? { count: 0, bytes: 0, examples: [], sizes: new Set() };
    group.count++;
    group.bytes += file.size;
    if (group.examples.length < 4) group.examples.push(file.name);
    if (dimensions) group.sizes.add(`${dimensions.width}x${dimensions.height}`);
    groups.set(kind, group);
  }
  const labels = { scan: 'laser scan or point cloud', splat: 'Gaussian splat', mesh: '3D mesh', video: 'video (360 or ordinary)', photo: 'photo',
    photo360: '360 photo (2:1)', archive: 'archive', texture: 'sidecar or texture', other: 'unrecognized' };
  const lines = [...groups].map(([kind, group]) => `${group.count} ${labels[kind]} file${group.count === 1 ? '' : 's'}, ${formatBytes(group.bytes)} (${group.examples.join(', ')}${group.count > group.examples.length ? ', ...' : ''})${group.sizes.size ? `, ${[...group.sizes].slice(0, 3).join(' ')}` : ''}`);
  const notes = [];
  if (found.length > maxFiles) notes.push(`There are more than ${maxFiles} files, the most one space holds. Put photo sets in a ZIP archive.`);
  if (groups.has('other')) notes.push('Some files are of a kind the processing may not use; they can still be uploaded with notes.');
  if (groups.has('photo') && !groups.has('photo360') && (groups.get('photo').count ?? 0) >= 20) notes.push('A set of ordinary photos can be processed into a Gaussian splat.');
  if (missing.length) notes.push(`Not found ${missing.join(', ')}.`);
  return [`${found.length} file${found.length === 1 ? '' : 's'}, ${formatBytes(total)} in total.`, ...lines,
    `Suggested title ${JSON.stringify(suggestTitle(paths, found))}.`, ...notes].join('\n');
}

function describePlan(plan) {
  const price = `${formatMoney(plan.amount, plan.currency)} a ${plan.intervalCount > 1 ? `${plan.intervalCount} ${plan.interval}s` : plan.interval}`;
  return plan.spaces === null ? `${plan.name}, ${price} for each space (id ${plan.id})` : `${plan.name}, ${price} for up to ${plan.spaces} spaces (id ${plan.id})`;
}

async function listPlans() {
  const { plans, account } = await api('/api/account/billing/plans');
  if (!account.billing) return 'Hosting on this site needs no payment.';
  const current = account.subscription && ['active', 'trialing', 'past_due'].includes(account.subscription.status) ? account.subscription : undefined;
  const lines = plans.map(describePlan);
  return [current
    ? `The account already pays for hosting (${current.plan?.spaces ? `a plan for up to ${current.plan.spaces} spaces` : 'pay as you go'}, ${account.spaceCount} spaces), so new spaces need no checkout.`
    : 'The account does not pay for hosting yet. The first space opens Stripe Checkout for one of these, with pay as you go chosen unless the person picks a plan.',
  ...lines, 'Plans can be changed later on the plan page of the account.'].join('\n');
}

async function resolvePlan(value) {
  if (!value) return undefined;
  const { plans } = await api('/api/account/billing/plans');
  const wanted = String(value).trim().toLowerCase();
  const plan = plans.find(item => item.id.toLowerCase() === wanted || item.name.toLowerCase() === wanted)
    ?? plans.find(item => item.name.toLowerCase().includes(wanted));
  if (!plan) throw new Problem(`No plan is called ${value}. The plans are ${plans.map(item => item.name).join(', ')}.`);
  return plan;
}

async function createSpace({ title, plan }) {
  const chosen = await resolvePlan(plan);
  let created;
  try { created = await api('/api/account/spaces', { method: 'POST', body: { title } }); }
  catch (error) {
    if (error.data?.planFull) {
      const url = `${brand.url}/account/plan`;
      openBrowser(url);
      throw new Problem(`${error.message} The plan page opened in the browser (${url}) so the person can move to a larger plan. Then call create_space again.`);
    }
    throw error;
  }
  const space = created.space;
  let checkout = created.checkout, portal = created.portal;
  if (chosen && checkout && created.plan !== chosen.id) checkout = (await api('/api/account/billing/checkout', { method: 'POST', body: { plan: chosen.id } })).url;
  const lines = [`Created the space ${JSON.stringify(space.title)} (space_id ${space.id}).`];
  if (checkout || portal) {
    const url = checkout ?? portal;
    const opened = openBrowser(url);
    lines.push(checkout
      ? `Hosting needs payment before files can upload. ${opened ? 'Stripe Checkout opened in the browser' : 'Give the person this Stripe Checkout link'} (${url}). Ask them to finish paying there, then call wait_for_payment.`
      : `Billing needs attention before files can upload. ${opened ? 'The billing page opened in the browser' : 'Give the person this billing link'} (${url}). Then call wait_for_payment.`);
  } else if (space.status === 'unpaid') {
    lines.push(`${created.error ?? 'Payment could not start.'} Call wait_for_payment, which tries again.`);
  } else lines.push('It is ready for files. Call upload_files next.');
  return lines.join(' ');
}

async function waitForPayment({ space_id }) {
  const deadline = Date.now() + toolWait;
  let nudge = Date.now() + 12000;
  for (;;) {
    const { space } = await api(`/api/account/spaces/${encodeURIComponent(space_id)}`);
    if (space.status !== 'unpaid' && space.hosted) return `Payment received. The space ${JSON.stringify(space.title)} is ready for files, so call upload_files next.`;
    if (Date.now() > deadline) return 'Still waiting for payment in Stripe Checkout. Ask the person whether they finished paying, then call wait_for_payment again.';
    // Returning from Checkout or the webhook usually records the payment; asking again applies a finished Checkout at once.
    if (Date.now() > nudge) {
      nudge = Date.now() + 15000;
      const result = await api('/api/account/billing/checkout', { method: 'POST' }).catch(error => ({ error }));
      if (result.url && !result.error && space.status === 'unpaid' && Date.now() + 15000 > deadline) {
        return `Still waiting for payment. If the Checkout tab was closed, give the person this link ${result.url} and call wait_for_payment again.`;
      }
    }
    await sleep(3000);
  }
}

async function uploadFiles({ space_id, paths, notes, output, submit = true }) {
  if (output !== undefined && !['splat', 'tour', 'auto'].includes(output)) throw new Problem('output is "splat", "tour" or "auto".');
  const { space } = await api(`/api/account/spaces/${encodeURIComponent(space_id)}`);
  if (space.status === 'unpaid') throw new Problem('This space is waiting for payment. Call wait_for_payment first.');
  if (!space.hosted) throw new Problem('Billing needs attention before files can upload. Ask the person to open their account page.');
  if (['queued', 'processing'].includes(space.status)) throw new Problem('This space is being processed, so files cannot be added until it finishes.');
  const existing = readJob(space.id);
  if (jobRunning(existing)) return `An upload into this space is already running. ${progressLine(existing)}`;
  const { found, missing } = await collectFiles(paths);
  if (!found.length) throw new Problem(missing.length ? `Nothing found at ${missing.join(', ')}.` : 'Those folders are empty.');
  if (found.length > maxFiles) throw new Problem(`That is more than ${maxFiles} files. Put photo sets in a ZIP archive and try again.`);
  const account = (await api('/api/account/billing/plans')).account;
  const already = space.uploads.filter(upload => upload.status !== 'deleted');
  const total = found.reduce((sum, file) => sum + file.size, 0) + already.reduce((sum, upload) => sum + upload.size, 0);
  if (account.maxSpaceBytes && total > account.maxSpaceBytes) throw new Problem(`That is ${formatBytes(total)}, more than the ${formatBytes(account.maxSpaceBytes)} one space can hold.`);
  // Files already uploaded under the same name and size are not sent twice.
  const complete = new Set(already.filter(upload => upload.status === 'complete').map(upload => `${upload.name}:${upload.size}`));
  const job = { spaceId: space.id, title: space.title, email: credentials()?.email, notes: typeof notes === 'string' ? notes.slice(0, 2000) : '', output,
    submit: submit !== false, status: 'waiting', created: new Date().toISOString(),
    files: found.map(file => ({ ...file, sent: 0, done: complete.has(`${file.name}:${file.size}`) })) };
  saveJob(job);
  const pid = startUploader(space.id);
  saveJob({ ...job, pid });
  // Early problems (a refused file, a lost link) show up within seconds.
  for (let waited = 0; waited < 6000; waited += 500) {
    await sleep(500);
    const current = readJob(space.id);
    if (current?.status === 'failed') throw new Problem(`The upload stopped. ${current.error}`);
    if (current?.files.some(file => file.uploadId)) break;
  }
  return [`Uploading ${found.length} file${found.length === 1 ? '' : 's'} (${formatBytes(found.reduce((sum, file) => sum + file.size, 0))}) into ${JSON.stringify(space.title)} in the background.`,
    'It keeps going if this conversation ends and resumes after network interruptions.',
    job.submit ? `When it finishes, the space is submitted for processing and ${brand.name} emails ${job.email ?? 'the account'} when it is ready.` : 'It will not be submitted for processing; call upload_files again with submit true when every file is added.',
    'Call space_status to follow it.'].join(' ');
}

function progressLine(job) {
  const progress = jobProgress(job);
  const running = jobRunning(job);
  const remaining = job.rate > 0 ? (progress.total - progress.sent) / job.rate : NaN;
  if (job.status === 'submitted') return `Upload finished (${progress.count} files, ${formatBytes(progress.total)}) and submitted for processing.`;
  if (job.status === 'uploaded') return `Upload finished (${progress.count} files, ${formatBytes(progress.total)}), not submitted yet.`;
  if (job.status === 'failed') return `The upload stopped at ${progress.percent}% (${job.error}). Calling upload_files again with the same paths resumes it.`;
  if (!running) return `The upload was interrupted at ${progress.percent}%. Calling upload_files again with the same paths resumes it.`;
  if (job.status === 'submitting') return 'Every file is uploaded and the space is being submitted for processing.';
  return `Uploading, ${progress.percent}% (${formatBytes(progress.sent)} of ${formatBytes(progress.total)}, ${progress.done} of ${progress.count} files)${job.rate > 0 ? `, about ${formatDuration(remaining)} left at ${formatBytes(job.rate)}/s` : ''}.`;
}

const statusText = { unpaid: 'waiting for payment', draft: 'waiting for files', queued: 'submitted and waiting for a processing agent',
  processing: 'being processed', ready: 'ready', failed: 'needs attention', deleted: 'deleted' };

function describeSpace(space) {
  const job = readJob(space.id);
  const link = space.scene ? `${brand.url}${space.scene.path}` : null;
  const parts = [`${JSON.stringify(space.title)} (space_id ${space.id}) is ${statusText[space.status] ?? space.status}`];
  if (space.status === 'ready' && link) parts.push(`at ${link}, ${space.scene.public ? 'public' : 'private (only the owner can open it)'}`);
  if (space.job?.progress && ['queued', 'processing'].includes(space.status)) parts.push(`latest step ${JSON.stringify(space.job.progress)}`);
  if (space.message && ['failed', 'ready'].includes(space.status)) parts.push(`message ${JSON.stringify(space.message)}`);
  let line = `${parts.join(', ')}.`;
  if (job && (jobRunning(job) || !['submitted'].includes(job.status) || ['draft', 'unpaid'].includes(space.status))) line += ` ${progressLine(job)}`;
  if (['queued', 'processing'].includes(space.status)) line += ` ${brand.name} emails the account when it is ready.`;
  return line;
}

async function spaceStatus({ space_id } = {}) {
  if (space_id) {
    const { space } = await api(`/api/account/spaces/${encodeURIComponent(space_id)}`);
    return describeSpace(space);
  }
  const { spaces, account } = await api('/api/account/spaces');
  if (!spaces.length) return `The account ${account.email} has no spaces yet.`;
  return [`${spaces.length} space${spaces.length === 1 ? '' : 's'} on ${account.email}.`, ...spaces.map(describeSpace)].join('\n');
}

async function setVisibility({ space_id, public: visible }) {
  const { space } = await api(`/api/account/spaces/${encodeURIComponent(space_id)}`, { method: 'PATCH', body: { public: Boolean(visible) } });
  return describeSpace(space);
}

async function unlinkAccount() {
  const saved = credentials();
  if (!saved) return 'This agent was not linked.';
  await api('/api/agent/token', { method: 'DELETE' }).catch(() => {});
  saveCredentials(undefined);
  return `Unlinked from ${saved.email}.`;
}

// ---------------------------------------------------------------------------------------------
// Tours and scavenger hunts

function describeTour(tour) {
  const stops = tour.experience?.stops?.length ?? tour.stops ?? 0;
  const kind = tour.kind === 'hunt' ? 'scavenger hunt' : 'guided tour';
  return `${JSON.stringify(tour.title)} (tour_id ${tour.id}), a ${kind} with ${stops} ${tour.kind === 'hunt' ? 'clue' : 'stop'}${stops === 1 ? '' : 's'}${tour.space?.title ? ` on ${JSON.stringify(tour.space.title)}` : ''}, ${tour.public ? `shared at ${brand.url}${tour.path}` : 'private (only the owner can open it)'}. Edit it in the browser at ${brand.url}${tour.editor}.`;
}

async function findTourSpaces({ query = '' } = {}) {
  const { spaces } = await api(`/api/account/tours/spaces?q=${encodeURIComponent(String(query))}&limit=30`);
  if (!spaces.length) return `No spaces match ${JSON.stringify(query)}. Try fewer or other words.`;
  return spaces.map(space => `${space.sceneId}: ${space.title} (${space.whose === 'own' ? 'your space' : `${brand.name} space`}${space.locations ? `, ${space.locations} places to stand` : ''})`).join('\n');
}

async function listTours() {
  const { tours } = await api('/api/account/tours');
  if (!tours.length) return 'There are no tours or scavenger hunts on this account yet. Start one with find_tour_spaces and create_tour.';
  return tours.map(tour => describeTour({ ...tour, space: tour.space ? { title: tour.space.title } : null })).join('\n');
}

async function createTour({ scene_id, kind = 'tour', title }) {
  const { tour } = await api('/api/account/tours', { method: 'POST', body: { sceneId: scene_id, kind, ...(title ? { title } : {}) } });
  return `Created ${describeTour({ ...tour, public: false, stops: 0 })} Next, draft_tour with what the person wants.`;
}

async function draftTour({ tour_id, request }) {
  await api(`/api/account/tours/${encodeURIComponent(tour_id)}/agent`, { method: 'POST', body: { prompt: String(request ?? ''), async: true } });
  return `${brand.name}'s tour agent is working on it; this takes one to five minutes. Call wait_for_tour with tour_id ${tour_id}.`;
}

async function waitForTour({ tour_id }) {
  const deadline = Date.now() + toolWait;
  for (;;) {
    const { tour } = await api(`/api/account/tours/${encodeURIComponent(tour_id)}?catalog=0`);
    const draft = tour.draft;
    if (draft?.state === 'failed') return `The draft failed: ${draft.error}. Try draft_tour again, perhaps with a simpler request.`;
    if (draft?.state !== 'drafting') {
      const stops = tour.experience.stops.map((stop, index) => `${index + 1}. ${stop.title}${stop.look ? ` [look ${stop.look.look}]` : ''}`).join('; ');
      return `${draft?.reply ? `The agent says: ${draft.reply}\n` : ''}${describeTour(tour)}\nStops: ${stops || 'none yet'}. Objects: ${tour.experience.objects.map(object => object.name).join(', ') || 'none'}. Effects: ${tour.experience.effects.map(effect => effect.type).join(', ') || 'none'}.${tour.experience.look ? ` Look: ${tour.experience.look.look}.` : ''}`;
    }
    if (Date.now() > deadline) return `Still drafting (started ${draft.started}). Call wait_for_tour again.`;
    await sleep(4000);
  }
}

/** The looks, effects, sounds and shapes a site offers, for editing a tour by hand. */
function describeCatalog(catalog) {
  if (!catalog) return '';
  const params = list => list.length ? ` Params ${list.join(', ')}.` : '';
  return [
    `Looks (a tour's or stop's "look": {"look": id, "transition": one of ${catalog.transitions.join(', ')}, "duration": seconds}; "color" is the capture as it is):`,
    ...catalog.looks.map(look => `${look.id} (${look.label}): ${look.description}${look.requires ? ' Gaussian splat spaces only.' : ''}${params(look.params)}`),
    'Effects ({"id", "type", "target": {"kind": "scene"} or {"kind": "object", "id"} or {"kind": "point", "position": [x,y,z]}, "params", "always"}):',
    ...catalog.effects.map(effect => `${effect.type} (${effect.label}): ${effect.description} Targets ${effect.targets.join(', ')}.${params(effect.params)}`),
    `Sounds: ${catalog.sounds.map(sound => `${sound.id} (${sound.kind})`).join(', ')}, or an https audio address.`,
    `Shapes (source {"kind": "shape", "shape", "color"}): ${catalog.shapes.map(shape => shape.shape).join(', ')}.`
  ].join('\n');
}

async function getTour({ tour_id }) {
  const { tour, catalog } = await api(`/api/account/tours/${encodeURIComponent(tour_id)}`);
  return `${describeTour(tour)}\nRevision ${tour.revision}. Experience JSON:\n${JSON.stringify(tour.experience, null, 1)}\n\n${describeCatalog(catalog)}`;
}

async function saveTour({ tour_id, experience, title }) {
  const { tour } = await api(`/api/account/tours/${encodeURIComponent(tour_id)}`);
  const value = typeof experience === 'string' ? JSON.parse(experience) : experience;
  const { tour: saved } = await api(`/api/account/tours/${encodeURIComponent(tour_id)}`, { method: 'PUT',
    body: { revision: tour.revision, experience: value, title: title ?? tour.title, public: tour.public } });
  return `Saved. ${describeTour({ ...tour, ...saved, experience: saved.experience })}`;
}

async function searchModels({ query, limit = 16 }) {
  const { models, total } = await api(`/api/library/search?q=${encodeURIComponent(String(query ?? ''))}&limit=${Number(limit) || 16}`, { auth: false });
  if (!models.length) return `No models match ${JSON.stringify(query)} among ${total}. Try other words.`;
  return models.map(model => `${model.name} (${model.category}${model.pack ? `, ${model.pack}` : ''}), about ${Math.round(model.height * 100) / 100} m tall at scale 1${model.animations?.length ? `, animated: ${model.animations.join(', ')}` : ''}: url ${model.url.startsWith('/') ? brand.url + model.url : model.url}`).join('\n');
}

async function uploadModel({ tour_id, path: file }) {
  requireSite();
  const saved = credentials();
  if (!saved) throw new Problem(`This agent is not linked to a ${brand.name} account yet. Call link_account first.`, 401);
  const target = path.resolve(String(file ?? ''));
  if (extension(target) !== 'glb') throw new Problem('Upload a .glb file (glTF Binary). In Blender: File > Export > glTF 2.0, format glTF Binary.');
  const bytes = readFileSync(target);
  if (bytes.length > 25 * 1024 * 1024) throw new Problem(`${path.basename(target)} is ${formatBytes(bytes.length)}; models can be up to 25 MB. Decimate it or export with Draco compression.`);
  const response = await fetch(`${brand.url}/api/account/tours/${encodeURIComponent(tour_id)}/models`, { method: 'POST', body: bytes, signal: AbortSignal.timeout(120000),
    headers: { 'Content-Type': 'model/gltf-binary', Authorization: `Bearer ${saved.token}`, 'User-Agent': `sphr-connector/${version}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Problem(data.error || `${brand.name} answered HTTP ${response.status}.`, response.status);
  return `Uploaded ${path.basename(target)} (${formatBytes(bytes.length)}). Use url ${data.url} as the object's source url: {"kind":"model","url":"${data.url}"}. Size and turn it with scale and rotation (degrees) in save_tour.`;
}

async function shareTour({ tour_id, public: shared, title }) {
  const { tour } = await api(`/api/account/tours/${encodeURIComponent(tour_id)}`, { method: 'PATCH', body: { ...(shared === undefined ? {} : { public: Boolean(shared) }), ...(title ? { title } : {}) } });
  return describeTour(tour);
}

// ---------------------------------------------------------------------------------------------
// MCP over stdio: newline-delimited JSON-RPC 2.0

const instructions = `${brand.name} hosts 3D captures (laser scans and E57 files, Matterport exports, Gaussian splats, 360 photos and video, meshes, photo sets) as virtual spaces with guided tours that are shared with a link. These tools let you publish captures from this computer for the person you are helping.

The usual order
1. check_files on the files or folders the person names. If they are vague, ask where the capture is rather than searching their disk.
2. link_account if you are not linked. A browser page opens where they approve the code; never ask for a password.
3. For the first space, list_plans and let the person choose (pay as you go is the default), then create_space with a title from check_files. Stripe Checkout opens in their browser; never ask for card details. Then wait_for_payment.
4. upload_files with every file of the capture in one call. It runs in the background, survives the chat ending and submits the space for processing when it finishes.
5. Tell the person the upload is running, roughly how long it will take (space_status), and that ${brand.name} will email them when the space is ready. Processing takes from minutes to a few hours depending on the capture.

One capture is one space. Put notes in upload_files when the person says what the capture is or how the tour should go. Spaces start private; offer set_visibility only when they are ready and the person wants to share.

Tours and scavenger hunts
A tour or hunt is built on a space (the person's own, or one of ${brand.name}'s public spaces) and has its own link. find_tour_spaces, then create_tour, then draft_tour with what the person wants in plain words and wait_for_tour; ${brand.name}'s tour agent sees the space's photographs, writes the stops, places library models, effects, sound and looks, and saves. To change details, get_tour, edit the JSON and save_tour, or ask draft_tour again. search_models finds ready-made 3D models. For an object the library does not have, and if you have a Blender MCP connected, build it in Blender (real-world meters, Y up, low poly, materials with base colors), export glTF Binary (.glb) with everything embedded, upload_model, and add it to the tour's objects with save_tour. Looks restyle the whole frame per stop (lines, watercolor, blueprint, noir, thermal, nightvision, neon, pixel and more) with transitions (cut, fade, dissolve, wipe, iris, sweep, glitch). Tours start private; share_tour when the person wants a link to send.`;

const prompts = [{
  name: 'publish_capture',
  description: `Publish a 3D capture from this computer as a ${brand.name} space`,
  arguments: [{ name: 'path', description: 'File or folder with the capture', required: false }]
}];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const supportedVersions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

async function handle(message) {
  const { id, method, params } = message;
  const reply = result => id !== undefined && send({ jsonrpc: '2.0', id, result });
  const fail = (code, text) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message: text } });
  switch (method) {
    case 'initialize':
      clientInfo = { name: String(params?.clientInfo?.name ?? ''), version: String(params?.clientInfo?.version ?? '') };
      return reply({ protocolVersion: supportedVersions.includes(params?.protocolVersion) ? params.protocolVersion : supportedVersions[0],
        capabilities: { tools: {}, prompts: {} }, serverInfo: { name: brand.slug, title: brand.name, version }, instructions });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: tools.map(({ run, ...tool }) => tool) });
    case 'tools/call': {
      const tool = tools.find(item => item.name === params?.name);
      if (!tool) return fail(-32602, `Unknown tool ${params?.name}`);
      try { return reply({ content: [{ type: 'text', text: await tool.run(params.arguments ?? {}) }] }); }
      catch (error) { return reply({ content: [{ type: 'text', text: error instanceof Problem ? error.message : `Something went wrong. ${error.message}` }], isError: true }); }
    }
    case 'prompts/list': return reply({ prompts });
    case 'prompts/get': {
      if (params?.name !== 'publish_capture') return fail(-32602, `Unknown prompt ${params?.name}`);
      const where = params.arguments?.path ? ` The capture is at ${params.arguments.path}.` : ' Ask me where the capture is on this computer.';
      return reply({ description: prompts[0].description, messages: [{ role: 'user', content: { type: 'text',
        text: `Publish my 3D capture as a ${brand.name} space.${where} Check the files, link my account, help me pay if needed, upload everything and tell me when to expect the email.` } }] });
    }
    case 'resources/list': return reply({ resources: [] });
    case 'resources/templates/list': return reply({ resourceTemplates: [] });
    default:
      if (id === undefined) return; // notifications need no answer
      return fail(-32601, `Method not found: ${method}`);
  }
}

function serve() {
  let buffer = '';
  const inFlight = new Set();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      for (const item of Array.isArray(message) ? message : [message]) {
        const work = handle(item).catch(error => item.id !== undefined && send({ jsonrpc: '2.0', id: item.id, error: { code: -32603, message: error.message } }));
        inFlight.add(work);
        work.finally(() => inFlight.delete(work));
      }
    }
  });
  // The client closing stdin ends the server once answers already under way are sent.
  process.stdin.on('end', () => Promise.allSettled([...inFlight]).then(() => process.exit(0)));
}

if (process.argv[2] === 'upload' && /^[a-f0-9]{12}$/.test(process.argv[3] ?? '')) {
  if (!existsSync(jobFile(process.argv[3]))) process.exit(1);
  await runUploader(process.argv[3]);
} else if (process.argv[2] === 'call') {
  const tool = tools.find(item => item.name === process.argv[3]);
  if (!tool) {
    console.error(`Usage: call <tool> [json arguments]. Tools: ${tools.map(item => item.name).join(', ')}`);
    process.exit(2);
  }
  clientInfo = { name: process.env.SPHR_CONNECTOR_CLIENT || 'An agent', version: '' };
  try {
    console.log(await tool.run(process.argv[4] ? JSON.parse(process.argv[4]) : {}));
  } catch (error) {
    console.error(error instanceof Problem ? error.message : `Something went wrong. ${error.message}`);
    process.exitCode = 1;
  }
} else {
  serve();
}
