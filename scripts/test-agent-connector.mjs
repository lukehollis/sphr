// End-to-end: a person's own agent links to their account through the connector (connector/server.mjs,
// driven over MCP stdio as Claude or Codex would), pays through Checkout, uploads a capture from
// disk in the background and submits it. A real Next development server runs against local
// stand-ins for Stripe, Google and email. Nothing leaves this machine.
//   node scripts/test-agent-connector.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';
import { fakeIdentityProvider, fakeStripe, listen, smtpSink } from './test-support/fake-services.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
assert.ok(!existsSync(path.join(root, 'public/datasets')), 'Run this in a checkout without local capture packages; it creates and removes public/datasets.');
const state = mkdtempSync(path.join(tmpdir(), 'sphr-agent-connector-'));
const connectorHome = path.join(state, 'connector-home');
const captures = path.join(state, 'captures');
const port = await new Promise(resolve => { const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
const base = `http://127.0.0.1:${port}`;
const webhookSecret = 'whsec_agent_test';
const clients = { google: { id: 'google-client', secret: 'google-secret' } };

const stripeFake = fakeStripe();
const stripeServer = await listen(stripeFake.handler);
const idp = fakeIdentityProvider({ clients });
const idpServer = await listen(idp.handler);
idp.state.base = idpServer.base;
const mail = await smtpSink();
const teamMessages = [];
const teamHook = await listen(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  teamMessages.push(JSON.parse(body).embeds[0]);
  response.statusCode = 204;
  response.end();
});
const signer = new Stripe('sk_test_signer');
mkdirSync(path.join(state, 'library'));
writeFileSync(path.join(state, 'library/index.json'), JSON.stringify({ models: [
  { id: 'tripod-bronze', name: 'Bronze tripod', category: 'Ancient Greece', url: 'https://models.example/tripod.glb', height: 1.2, tags: ['delphi', 'oracle'] },
  { id: 'goat', name: 'Sacred goat', category: 'Animals', url: 'https://models.example/goat.glb', height: 0.8, animations: ['Idle', 'Walk'] }] }));

const env = { ...process.env, SPHR_BUILD_DIR: '.next-agent-test', SPHR_PUBLIC_URL: base, SPHR_STATE_DIR: state,
  SPHR_ACCESS_CONTROL: '1', SPHR_ACCOUNTS: '1', SPHR_CATALOG_URL: '', SPHR_ASSET_BASE_URL: '', NEXT_PUBLIC_SPHR_ASSET_BASE_URL: '',
  SPHR_SMTP_URL: `smtp://127.0.0.1:${mail.port}`, SPHR_MAIL_FROM: 'Spaces <no-reply@example.com>',
  SPHR_OAUTH_TEST_BASE: idpServer.base, SPHR_GOOGLE_CLIENT_ID: clients.google.id, SPHR_GOOGLE_CLIENT_SECRET: clients.google.secret,
  SPHR_STRIPE_SECRET_KEY: 'sk_test_fake', SPHR_STRIPE_PRICE_ID: 'price_space', SPHR_STRIPE_WEBHOOK_SECRET: webhookSecret, SPHR_STRIPE_TEST_API: stripeServer.base,
  SPHR_STRIPE_PLAN_PRICES: 'price_starter,price_pro,price_enterprise', SPHR_WORKER_TOKEN: randomBytes(24).toString('hex'),
  SPHR_UPLOAD_MAX_GB: '1', SPHR_UPLOAD_BUCKET: '', SPHR_DISCORD_WEBHOOK_URL: `${teamHook.base}/hook`,
  SPHR_LIBRARY_FILE: path.join(state, 'library/index.json'), SPHR_LIBRARY_URL: '', SPHR_TOUR_AGENT_URL: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '',
  // A stand-in for the tour agent that points at pixels, so drafts are placed for real.
  SPHR_TOUR_AGENT_COMMAND: JSON.stringify([process.execPath, path.join(root, 'scripts/test-support/fake-tour-agent.mjs')]), FAKE_TOUR_AGENT_LOG: path.join(state, 'tour-agent.log') };
delete env.NODE_ENV;
for (const name of ['SPHR_APPLE_CLIENT_ID', 'SPHR_LINKEDIN_CLIENT_ID']) delete env[name];
const generated = Object.fromEntries(['tsconfig.json', 'next-env.d.ts'].map(name => [name, readFileSync(path.join(root, name), 'utf8')]));
const app = spawn(path.join(root, 'node_modules/.bin/next'), ['dev', '-p', String(port), '-H', '127.0.0.1'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let appLog = '';
app.stdout.on('data', chunk => { appLog += chunk; });
app.stderr.on('data', chunk => { appLog += chunk; });

let connector;
async function cleanup() {
  connector?.child.kill();
  const exited = new Promise(resolve => app.exitCode !== null ? resolve() : app.once('exit', resolve));
  app.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 10000))]);
  for (const server of [stripeServer.server, idpServer.server, mail.server, teamHook.server]) server.close();
  rmSync(state, { recursive: true, force: true });
  rmSync(path.join(root, 'public/datasets'), { recursive: true, force: true });
  rmSync(path.join(root, '.next-agent-test'), { recursive: true, force: true });
  for (const [name, content] of Object.entries(generated)) writeFileSync(path.join(root, name), content);
}

class Browser {
  cookies = new Map();
  async request(route, { method = 'GET', json, headers = {} } = {}) {
    const response = await fetch(route.startsWith('http') ? route : base + route, { method, redirect: 'manual', headers: {
      ...(method !== 'GET' ? { Origin: base } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...(this.cookies.size ? { Cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ') } : {}), ...headers },
      body: json ? JSON.stringify(json) : undefined });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair, ...attributes] = cookie.split(';');
      const [name, value] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
      if (!value || attributes.some(attribute => /max-age=0\b/i.test(attribute.trim()))) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }
  get(route, options) { return this.request(route, options); }
  post(route, json, options) { return this.request(route, { method: 'POST', json: json ?? {}, ...options }); }
}

const location = response => response.headers.get('location');
function webhook(event) {
  const payload = JSON.stringify({ object: 'event', api_version: '2026-08-26.dahlia', created: Math.floor(Date.now() / 1000), ...event });
  return fetch(`${base}/api/stripe/webhook`, { method: 'POST', body: payload, headers: { 'Content-Type': 'application/json',
    'Stripe-Signature': signer.webhooks.generateTestHeaderString({ payload, secret: webhookSecret }) } });
}

async function signInWithGoogle(browser, claims, next) {
  const start = await browser.get(`/api/auth/google${next ? `?next=${encodeURIComponent(next)}` : ''}`);
  assert.equal(start.status, 303);
  const { code, params } = idp.authorize(location(start), claims);
  return browser.get(`/api/auth/google/callback?code=${code}&state=${encodeURIComponent(params.state)}`);
}

/** A glTF binary of plain triangles: [x, y, z] corners, three per triangle. */
function glbOf(triangles) {
  const positions = Float32Array.from(triangles.flat(2));
  const bin = Buffer.from(positions.buffer);
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteLength: bin.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3' }] }));
  const padded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + padded.length + 8 + bin.length, 8);
  const chunk = (type, body) => { const head = Buffer.alloc(8); head.writeUInt32LE(body.length, 0); head.writeUInt32LE(type, 4); return Buffer.concat([head, body]); };
  return Buffer.concat([header, chunk(0x4e4f534a, padded), chunk(0x004e4942, bin)]);
}

/** The connector as an MCP client sees it: newline-delimited JSON-RPC over stdio. */
function startConnector(clientName = 'claude-ai') {
  const child = spawn(process.execPath, [path.join(root, 'connector/server.mjs')], { stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, SPHR_URL: base, SPHR_NAME: 'Example Spaces', SPHR_CONNECTOR_HOME: connectorHome, SPHR_CONNECTOR_NO_BROWSER: '1' } });
  const waiting = new Map();
  let next = 0;
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  child.on('exit', code => { for (const resolve of waiting.values()) resolve({ error: { message: `The connector exited with ${code}` } }); waiting.clear(); });
  const rpc = (method, params) => new Promise(resolve => {
    const id = ++next;
    if (child.exitCode !== null) return resolve({ error: { message: 'The connector is not running' } });
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const call = async (name, args = {}) => {
    const message = await rpc('tools/call', { name, arguments: args });
    assert.ok(message.result, JSON.stringify(message));
    return { text: message.result.content.map(item => item.text).join('\n'), error: Boolean(message.result.isError) };
  };
  return { child, rpc, call, notify: (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`), clientName };
}

async function until(check, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

try {
  for (let attempt = 0; ; attempt++) {
    const ready = await fetch(`${base}/account/login`).catch(() => undefined);
    if (ready?.status === 200) break;
    if (attempt > 240) throw new Error(`The development server did not start.\n${appLog}`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // ---- Protocol ----
  connector = startConnector();
  const init = await connector.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1.0' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.match(init.result.instructions, /Example Spaces hosts 3D captures/);
  connector.notify('notifications/initialized');
  const listed = (await connector.rpc('tools/list', {})).result.tools.map(tool => tool.name);
  assert.deepEqual(listed, ['link_account', 'check_files', 'list_plans', 'create_space', 'wait_for_payment', 'upload_files', 'space_status', 'set_visibility', 'unlink_account',
    'find_tour_spaces', 'list_tours', 'create_tour', 'draft_tour', 'wait_for_tour', 'get_tour', 'save_tour', 'search_models', 'upload_model', 'upload_sky', 'share_tour']);
  assert.equal((await connector.rpc('nonsense/method', {})).error.code, -32601);
  assert.equal((await connector.rpc('prompts/list', {})).result.prompts[0].name, 'publish_capture');
  let result = await connector.call('space_status');
  assert.ok(result.error && /not linked/.test(result.text), 'tools that need an account say to link first');

  // ---- Local files, before any account ----
  mkdirSync(path.join(captures, 'Riverside studio'), { recursive: true });
  const scan = randomBytes(17 * 1024 * 1024 + 321);
  writeFileSync(path.join(captures, 'Riverside studio', 'riverside.e57'), scan);
  const png = Buffer.alloc(40);
  png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(4096, 16); png.writeUInt32BE(2048, 20);
  writeFileSync(path.join(captures, 'Riverside studio', 'lobby.png'), png);
  writeFileSync(path.join(captures, 'Riverside studio', '.DS_Store'), 'x');
  result = await connector.call('check_files', { paths: [path.join(captures, 'Riverside studio')] });
  assert.ok(!result.error, result.text);
  assert.match(result.text, /^2 files/);
  assert.match(result.text, /1 laser scan or point cloud file/);
  assert.match(result.text, /1 360 photo \(2:1\) file/);
  assert.match(result.text, /Suggested title "Riverside studio"/);
  assert.ok((await connector.call('check_files', { paths: [path.join(captures, 'missing')] })).error);

  // ---- Linking: the browser approves the code the agent shows ----
  const linking = connector.call('link_account');
  const pending = await until(() => { try { return JSON.parse(readFileSync(path.join(connectorHome, 'pending-link.json'), 'utf8')); } catch { return undefined; } }, 'a link code');
  assert.match(pending.userCode, /^[B-Z2-9]{4}-[B-Z2-9]{4}$/);
  assert.equal(pending.url, `${base}/account/connect/${pending.userCode}`);
  const alice = new Browser();
  assert.equal(location(await alice.get(`/account/connect/${pending.userCode}`)), `/account/login?next=${encodeURIComponent(`/account/connect/${pending.userCode}`)}`,
    'the approval page asks for sign-in first');
  const back = await signInWithGoogle(alice, { sub: 'alice-google', email: 'alice@example.com', email_verified: true, name: 'Alice' }, `/account/connect/${pending.userCode}`);
  assert.equal(new URL(location(back), base).pathname, `/account/connect/${pending.userCode}`, 'sign-in returns to the approval page');
  const page = (await (await alice.get(`/account/connect/${pending.userCode}`)).text()).replaceAll('<!-- -->', '');
  assert.ok(page.includes(`Link Claude on`), 'the page names the agent');
  assert.ok(page.includes(pending.userCode) && page.includes('alice@example.com'));
  assert.equal((await alice.post('/api/account/agents', { code: pending.userCode }, { headers: { Origin: 'https://evil.example' } })).status, 400, 'approval is same-origin only');
  assert.equal((await fetch(`${base}/api/agent/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: pending.code }) }).then(r => r.json())).status, 'pending');
  assert.equal((await alice.post('/api/account/agents', { code: pending.userCode.toLowerCase().replace('-', ' ') })).status, 200, 'codes are forgiving about case and spacing');
  result = await linking;
  assert.ok(!result.error, result.text);
  assert.match(result.text, /Linked to the Example Spaces account alice@example.com/);
  const saved = JSON.parse(readFileSync(path.join(connectorHome, 'credentials.json'), 'utf8'))[base];
  assert.match(saved.token, /^sphr_[a-f0-9]{64}$/);
  if (process.platform !== 'win32') assert.equal(readFileSync(path.join(connectorHome, 'credentials.json')).length > 0 && (await import('node:fs')).statSync(path.join(connectorHome, 'credentials.json')).mode & 0o777, 0o600);
  assert.equal((await fetch(`${base}/api/agent/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: pending.code }) })).status, 410, 'a link becomes a token once');
  assert.equal((await alice.post('/api/account/agents', { code: pending.userCode })).status, 410, 'a used code cannot be approved again');
  assert.match((await connector.call('link_account')).text, /Already linked/);

  // ---- What a token may and may not do ----
  const bearer = { Authorization: `Bearer ${saved.token}` };
  const agentFetch = (route, init = {}) => fetch(base + route, { ...init, headers: { ...bearer, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } });
  assert.equal((await agentFetch('/api/account/spaces')).status, 200);
  assert.equal((await fetch(`${base}/api/account/spaces`, { headers: { Authorization: `Bearer sphr_${'0'.repeat(64)}` } })).status, 401, 'unknown tokens are refused');
  assert.equal((await fetch(`${base}/api/account/spaces`, { headers: { Authorization: 'Bearer nonsense', Cookie: [...alice.cookies].map(([n, v]) => `${n}=${v}`).join('; ') } })).status, 401,
    'a bad token never falls back to the browser session');
  assert.equal((await agentFetch('/api/account/agents')).status, 401, 'agents cannot list or approve other agents');
  assert.equal((await agentFetch('/api/account/agents', { method: 'POST', body: JSON.stringify({ code: 'BBBB-BBBB' }) })).status, 401);
  assert.equal((await agentFetch('/api/account/billing/portal', { method: 'POST', body: '{}' })).status, 401, 'billing management stays in the browser');
  assert.equal((await agentFetch('/api/account/spaces/000000000000', { method: 'DELETE', body: '{}' })).status, 401, 'deleting spaces stays in the browser');

  // ---- Plans, a space, and payment in the browser ----
  result = await connector.call('list_plans');
  assert.match(result.text, /does not pay for hosting yet/);
  assert.match(result.text, /Pay as you go, \$1\.00 a month for each space/);
  result = await connector.call('create_space', { title: 'Riverside studio', plan: 'Starter' });
  assert.ok(!result.error, result.text);
  const spaceId = result.text.match(/space_id ([a-f0-9]{12})/)[1];
  assert.match(result.text, /Stripe Checkout/);
  const sessions = [...stripeFake.state.sessions.values()];
  const session = sessions.at(-1);
  assert.equal(session.price, 'price_starter', 'the plan the person chose');
  assert.equal(session.success_url, `${base}/account?checkout={CHECKOUT_SESSION_ID}&agent=1`, 'Checkout returns to a page that points back to the agent');
  result = await connector.call('upload_files', { space_id: spaceId, paths: [path.join(captures, 'Riverside studio')] });
  assert.ok(result.error && /waiting for payment/.test(result.text), 'uploads wait for payment');
  const waiting = connector.call('wait_for_payment', { space_id: spaceId });
  await new Promise(resolve => setTimeout(resolve, 1500));
  const subscription = stripeFake.state.pay(session.id);
  assert.equal((await webhook({ id: 'evt_agent_paid', type: 'checkout.session.completed', data: { object: { id: session.id } } })).status, 200);
  result = await waiting;
  assert.match(result.text, /Payment received/);
  assert.ok((await (await alice.get(`/account?checkout=${session.id}&agent=1`)).text()).includes('Your agent can upload the files now'));
  assert.ok(subscription);

  // ---- Background upload, resumed and submitted ----
  result = await connector.call('upload_files', { space_id: spaceId, paths: [path.join(captures, 'Riverside studio')], notes: 'Ground floor studio, start at the lobby.' });
  assert.ok(!result.error, result.text);
  assert.match(result.text, /Uploading 2 files .* in the background/);
  assert.match(result.text, /emails alice@example.com/);
  const job = await until(() => {
    const value = JSON.parse(readFileSync(path.join(connectorHome, 'uploads', `${spaceId}.json`), 'utf8'));
    if (value.status === 'failed') throw new Error(value.error);
    return value.status === 'submitted' && value;
  }, 'the upload to finish');
  assert.equal(job.files.filter(file => file.done).length, 2);
  const { space } = await (await agentFetch(`/api/account/spaces/${spaceId}`)).json();
  assert.equal(space.status, 'queued', 'the finished upload is submitted for processing');
  assert.equal(space.notes, 'Ground floor studio, start at the lobby.');
  const stored = space.uploads.find(upload => upload.name === 'riverside.e57');
  assert.equal(stored.status, 'complete');
  const bytes = readFileSync(path.join(state, 'uploads/uploads', spaceId, stored.id, 'riverside.e57'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), createHash('sha256').update(scan).digest('hex'), 'the stored scan matches the file on disk');
  await mail.waitFor(message => message.includes('To: alice@example.com') && message.includes('Processing started for Riverside studio'));
  result = await connector.call('space_status', { space_id: spaceId });
  assert.match(result.text, /submitted and waiting for a processing agent/);
  assert.match(result.text, /emails the account when it is ready/);
  result = await connector.call('set_visibility', { space_id: spaceId, public: true });
  assert.ok(result.error && /not ready/.test(result.text));
  result = await connector.call('upload_files', { space_id: spaceId, paths: [path.join(captures, 'Riverside studio')] });
  assert.ok(result.error && /being processed/.test(result.text));

  // ---- A tour of one of the operator's public spaces, with a model made in Blender ----
  const court = path.join(root, 'public/datasets/legacy/temple-court');
  mkdirSync(court, { recursive: true });
  // Its capture mesh: open ground, and an altar platform half a meter high a few meters out.
  const quad = (x0, x1, y, z0, z1) => [[[x0, y, z0], [x1, y, z0], [x1, y, z1]], [[x0, y, z0], [x1, y, z1], [x0, y, z1]]];
  writeFileSync(path.join(court, 'mesh.glb'), glbOf([...quad(-20, 20, 0, -20, 20), ...quad(-3, 3, 0.5, 2, 6)]));
  writeFileSync(path.join(court, 'bootstrap.json'), JSON.stringify({ space: { id: '0b0b0b0b0b01', title: 'Temple court', type: 'spaces',
    space_data: { nodes: [{ uuid: 'court-1', label: 'Altar', position: { x: 0, y: 1.5, z: 0 }, floorPosition: { x: 0, y: 0, z: 0 }, image: '/datasets/legacy/temple-court/pano.jpg' }],
      sceneGraph: [{ id: 'capture-mesh', type: 'model', file: '/datasets/legacy/temple-court/mesh.glb', raycast: true }] } } }));
  writeFileSync(path.join(root, 'public/datasets/legacy/index.json'), JSON.stringify({ spaces: [{ sceneId: '0b0b0b0b0b01', titleSlug: 'temple-court',
    scenePath: '/s/0b0b0b0b0b01/temple-court', slug: 'temple-court', title: 'Temple court', bootstrapUrl: '/datasets/legacy/temple-court/bootstrap.json',
    thumbnail: '/datasets/legacy/temple-court/preview.jpg', nodeCount: 1, createdAt: '2026-01-01', sourceType: 'panoramas' }] }));
  new DatabaseSync(path.join(state, 'admin.sqlite')).prepare('INSERT OR REPLACE INTO visibility VALUES (?, ?)').run('0b0b0b0b0b01', 1);
  result = await connector.call('find_tour_spaces', { query: 'temple' });
  assert.equal(result.text, '0b0b0b0b0b01: Temple court (Example Spaces space, 360 photos, 1 places to stand)');
  assert.match((await connector.call('find_tour_spaces', { query: 'volcano' })).text, /No spaces match/);
  result = await connector.call('create_tour', { scene_id: '0b0b0b0b0b01', kind: 'tour', title: 'The oracle' });
  assert.ok(!result.error, result.text);
  const tourId = result.text.match(/tour_id ([a-f0-9]{12})/)[1];
  assert.match(result.text, /"The oracle" \(tour_id [a-f0-9]{12}\), a guided tour with 0 stops, private/);
  // The site's tour agent drafts in the background; the server places what it points at on the capture mesh.
  result = await connector.call('draft_tour', { tour_id: tourId, request: 'A short tour of the altar' });
  assert.ok(!result.error, result.text);
  assert.match(result.text, /working on it/);
  result = await connector.call('wait_for_tour', { tour_id: tourId });
  assert.match(result.text, /The agent says: I placed the tripod on the altar platform/);
  assert.match(result.text, /Stops: 1\. The altar \[look color\]\. Objects: Bronze tripod\. Effects: beacon\. Look: lines\./);
  const drafted = (await (await agentFetch(`/api/account/tours/${tourId}?catalog=0`)).json()).tour.experience;
  const [tripodObject] = drafted.objects;
  const out = 1.5 / Math.tan(Math.PI * 0.12);
  assert.ok(Math.abs(tripodObject.position[1] - 0.51) < 0.01, `it stands on the altar platform, not the ground (${tripodObject.position})`);
  assert.ok(Math.abs(Math.hypot(tripodObject.position[0], tripodObject.position[2]) - out / 1.5) < 0.05, 'where the pointed ray meets the platform');
  assert.deepEqual(tripodObject.scale, [1, 1, 1], 'near things keep their size');
  assert.ok(['https://models.example/tripod.glb', 'https://models.example/goat.glb'].includes(tripodObject.source.url), 'library codes become model addresses');
  assert.deepEqual(drafted.effects[0].target.position, tripodObject.position, 'the beacon marks the same spot');
  assert.ok(drafted.stops[0].view.rotation.polar < -15, 'the stop looks down at the altar');
  const told = JSON.parse(readFileSync(path.join(state, 'tour-agent.log'), 'utf8').trim().split('\n')[0]).prompt;
  assert.match(told, /Kind of capture: 1 panorama locations with a 3D mesh/);
  assert.match(told, /Drawn versions: none yet/);
  assert.match(told, /Sacred goat, Animals, about 0\.8 m tall at scale 1, animated: Idle, Walk/, 'the agent sees which models move');
  assert.match(told, /^lines \(Line drawing\): /m);
  assert.match(told, /^confetti \(Confetti\): .* Params .*trigger one of stop\|found\|hint\|click default stop \(stop runs with its stop/m, 'the drafting agent sees the trigger');
  assert.match(told, /aim it at the hunt object with "trigger": "found"/, 'and is told to celebrate finds with it');
  result = await connector.call('get_tour', { tour_id: tourId });
  assert.match(result.text, /Revision 1\. Experience JSON/, 'the draft was saved');
  assert.match(result.text, /^blueprint \(Blueprint\): /m, 'get_tour lists the looks');
  assert.match(result.text, /transition": one of cut, fade, dissolve, wipe, iris, sweep, glitch/);
  assert.match(result.text, /^music \(Background music\): .* Params track /m);
  assert.match(result.text, /^confetti \(Confetti\): .*only when a hunt item is found\. .* Params .*trigger one of stop\|found\|hint\|click default stop \(stop runs with its stop .+ holds it back until that moment alone\)/m,
    'get_tour says an effect can hold back for the find');
  result = await connector.call('search_models', { query: 'oracle' });
  assert.equal(result.text, 'Bronze tripod (Ancient Greece), about 1.2 m tall at scale 1: url https://models.example/tripod.glb');
  assert.match((await connector.call('search_models', { query: 'goat' })).text, /^Sacred goat \(Animals\), about 0\.8 m tall at scale 1, animated: Idle, Walk: url /);
  // A model exported from Blender as glTF Binary.
  const gltf = Buffer.from(JSON.stringify({ asset: { version: '2.0', generator: 'Khronos glTF Blender I/O' }, meshes: [{ name: 'Tripod', primitives: [] }] }).padEnd(96, ' '));
  const model = Buffer.alloc(20 + gltf.length);
  model.writeUInt32LE(0x46546c67, 0); model.writeUInt32LE(2, 4); model.writeUInt32LE(model.length, 8); model.writeUInt32LE(gltf.length, 12); model.writeUInt32LE(0x4e4f534a, 16);
  gltf.copy(model, 20);
  writeFileSync(path.join(captures, 'tripod.glb'), model);
  writeFileSync(path.join(captures, 'tripod.blend'), 'BLENDER');
  assert.match((await connector.call('upload_model', { tour_id: tourId, path: path.join(captures, 'tripod.blend') })).text, /Upload a \.glb file/);
  result = await connector.call('upload_model', { tour_id: tourId, path: path.join(captures, 'tripod.glb') });
  assert.ok(!result.error, result.text);
  const tripodUrl = result.text.match(/url (\/api\/tour-files\/\S+\.glb)/)[1];
  assert.ok(Buffer.from(await (await fetch(base + tripodUrl)).arrayBuffer()).equals(model), 'the uploaded model is served as it was sent');
  // A 360 sky of the person's own (a JPEG header is enough for the server to check its shape).
  const sky = Buffer.alloc(64);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).copy(sky, 0);
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x08, 0x00, 0x10, 0x00, 0x03]).copy(sky, 20);
  writeFileSync(path.join(captures, 'night-sky.jpg'), sky);
  writeFileSync(path.join(captures, 'night-sky.tif'), 'TIFF');
  assert.match((await connector.call('upload_sky', { tour_id: tourId, path: path.join(captures, 'night-sky.tif') })).text, /JPEG, PNG or WebP/);
  result = await connector.call('upload_sky', { tour_id: tourId, path: path.join(captures, 'night-sky.jpg') });
  assert.ok(!result.error, result.text);
  const skyUrl = result.text.match(/"url":"(\/api\/tour-files\/[^"]+\.jpg)"/)[1];
  assert.match((await connector.call('get_tour', { tour_id: tourId })).text, /Skies \(a tour's or stop's "sky"[\s\S]*drawn-night \(Starry night, night\)/);
  result = await connector.call('save_tour', { tour_id: tourId, experience: { version: 1, kind: 'tour', look: { look: 'lines', transition: 'sweep', duration: 2 }, sky: { sky: 'custom', url: skyUrl },
    objects: [{ id: 'tripod', name: 'Bronze tripod', source: { kind: 'model', url: tripodUrl }, position: [0, 0, -3], rotation: [0, 0, 0], scale: [1, 1, 1] }],
    effects: [], stops: [{ id: 'altar', title: 'The altar', text: 'The oracle sat here.', format: 'plain', view: { nodeId: 'court-1', rotation: { azimuth: 0, polar: -5 } },
      look: { look: 'color', transition: 'iris' }, sky: { sky: 'drawn-night' }, objects: ['tripod'], effects: [] }] } });
  assert.ok(!result.error, result.text);
  assert.match(result.text, /^Saved\. "The oracle" .* with 1 stop on "Temple court"/);
  result = await connector.call('save_tour', { tour_id: tourId, experience: { version: 1, kind: 'tour', objects: [], effects: [],
    stops: [{ id: 'nowhere', title: 'Lost', text: 'Nowhere.', view: { nodeId: 'not-a-location' }, objects: [], effects: [] }] } });
  assert.ok(result.error, 'stops must stand in the space');
  result = await connector.call('wait_for_tour', { tour_id: tourId });
  assert.match(result.text, /Stops: 1\. The altar \[look color, sky drawn-night\]\. Objects: Bronze tripod\. Effects: none\. Look: lines\. Sky: custom\./);
  result = await connector.call('share_tour', { tour_id: tourId, public: true });
  assert.match(result.text, new RegExp(`shared at ${base}/t/${tourId}/the-oracle`));
  assert.ok((await (await fetch(`${base}/t/${tourId}/the-oracle`)).text()).includes(tripodUrl), 'anyone with the link sees the tour and its model');
  assert.match((await connector.call('list_tours')).text, /"The oracle" .* shared at/);

  // ---- A Gaussian splat space has no panoramas: the agent sees views drawn on the server ----
  const garden = path.join(root, 'public/datasets/legacy/garden-court');
  mkdirSync(garden, { recursive: true });
  // The splat's points (32-byte .splat rows): open ground, and a table top 0.75 m up five meters ahead.
  const splatRow = (x, y, z, [r, g, b]) => {
    const row = Buffer.alloc(32);
    row.writeFloatLE(x, 0); row.writeFloatLE(y, 4); row.writeFloatLE(z, 8);
    for (const offset of [12, 16, 20]) row.writeFloatLE(0.05, offset);
    row.set([r, g, b, 255, 128, 128, 128, 255], 24);
    return row;
  };
  const rows = [];
  for (let x = -6; x <= 6; x += 0.08) for (let z = -8; z <= 4; z += 0.08) rows.push(splatRow(x, 0, z, [70, 140, 60]));
  for (let x = -0.6; x <= 0.6; x += 0.03) for (let z = -3.6; z <= -2.4; z += 0.03) rows.push(splatRow(x, 0.75, z, [120, 80, 40]));
  writeFileSync(path.join(garden, 'scene.splat'), Buffer.concat(rows));
  // The start view looks from 1.6 m up straight at the middle of the table.
  writeFileSync(path.join(garden, 'bootstrap.json'), JSON.stringify({ space: { id: '0b0b0b0b0b02', title: 'Garden court', type: 'splat',
    space_data: { noPanos: true, initialPosition: { x: 0, y: 1.6, z: 2 }, initialRotation: { azimuth: 0, polar: -9.65 },
      splats: [{ id: 'main', url: '/datasets/legacy/garden-court/scene.splat', fileType: 'splat' }] } } }));
  const catalog = JSON.parse(readFileSync(path.join(root, 'public/datasets/legacy/index.json'), 'utf8'));
  catalog.spaces.push({ sceneId: '0b0b0b0b0b02', titleSlug: 'garden-court', scenePath: '/s/0b0b0b0b0b02/garden-court', slug: 'garden-court', title: 'Garden court',
    bootstrapUrl: '/datasets/legacy/garden-court/bootstrap.json', thumbnail: '/datasets/legacy/garden-court/preview.jpg', nodeCount: 0, createdAt: '2026-01-01', sourceType: 'splat' });
  writeFileSync(path.join(root, 'public/datasets/legacy/index.json'), JSON.stringify(catalog));
  new DatabaseSync(path.join(state, 'admin.sqlite')).prepare('INSERT OR REPLACE INTO visibility VALUES (?, ?)').run('0b0b0b0b0b02', 1);
  result = await connector.call('create_tour', { scene_id: '0b0b0b0b0b02', kind: 'tour', title: 'Garden table' });
  const gardenTour = result.text.match(/tour_id ([a-f0-9]{12})/)[1];
  assert.match((await connector.call('draft_tour', { tour_id: gardenTour, request: 'Show the table' })).text, /working on it/);
  result = await connector.call('wait_for_tour', { tour_id: gardenTour });
  assert.match(result.text, /Stops: 1\. The altar/, result.text);
  const gardenDraft = (await (await agentFetch(`/api/account/tours/${gardenTour}?catalog=0`)).json()).tour.experience;
  const [onTable] = gardenDraft.objects;
  assert.ok(onTable.position[1] > 0.7 && onTable.position[1] < 0.85 && onTable.position[2] < -2.3 && onTable.position[2] > -3.7,
    `the object stands on the table the agent pointed at in the drawn view (${onTable.position.map((value) => value.toFixed(2))})`);
  assert.deepEqual(gardenDraft.stops[0].view.position, { x: 0, y: 1.6, z: 2 }, 'the stop stands where the view was drawn from');
  const gardenPrompt = readFileSync(path.join(state, 'tour-agent.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).prompt).find((text) => text.includes('Garden court'));
  assert.match(gardenPrompt, /This space has no panoramas, so it is shown in views drawn from its 3D Gaussian splat/);
  assert.match(gardenPrompt, /Images of the space are files in .*01-view-s1\.jpg is view s1/s, 'the drawn views go to the agent as pictures');
  assert.ok(existsSync(path.join(state, 'space-views')), 'the drawn views are kept for the next draft');

  // ---- The account page lists the agent; unlinking there or from the agent revokes it ----
  const agents = await (await alice.get('/api/account/agents')).json();
  assert.equal(agents.agents.length, 1);
  assert.match(agents.agents[0].client, /^Claude on /);
  assert.ok(agents.agents[0].used, 'last use is recorded');
  assert.ok((await (await alice.get('/account')).text()).includes('Linked agents'));
  result = await connector.call('unlink_account');
  assert.match(result.text, /Unlinked from alice@example.com/);
  assert.equal((await agentFetch('/api/account/spaces')).status, 401, 'the token no longer works');
  assert.equal((await (await alice.get('/api/account/agents')).json()).agents.length, 0);

  // A second link, revoked from the browser, makes the agent say it must link again.
  const relinking = connector.call('link_account');
  const second = await until(() => { try { const value = JSON.parse(readFileSync(path.join(connectorHome, 'pending-link.json'), 'utf8')); return value.code !== pending.code && value; } catch { return undefined; } }, 'a second code');
  assert.equal((await alice.post('/api/account/agents', { code: second.userCode })).status, 200);
  assert.match((await relinking).text, /Linked/);
  const [linked] = (await (await alice.get('/api/account/agents')).json()).agents;
  assert.equal((await alice.request(`/api/account/agents/${linked.id}`, { method: 'DELETE', json: {} })).status, 200);
  result = await connector.call('space_status');
  assert.ok(result.error && /no longer linked/.test(result.text));

  // Declining a code ends it for the agent.
  const declined = await fetch(`${base}/api/agent/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: 'Codex on test' }) }).then(r => r.json());
  assert.equal((await alice.post('/api/account/agents', { code: declined.userCode, approve: false })).status, 200);
  assert.equal((await fetch(`${base}/api/agent/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: declined.code }) })).status, 410);
  assert.ok((await (await alice.get(`/account/connect/${declined.userCode}`)).text()).includes('This code has expired'));

  // ---- The hosted endpoint for agents that run in the cloud (Meta Muse, claude.ai and the like) ----
  const mcp = async (messages, headers = {}) => {
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify(messages) });
    return { response, body: response.status === 202 || response.status === 204 ? undefined : await response.json() };
  };
  const tool = async (name, args, headers) => {
    const { response, body } = await mcp({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method: 'tools/call', params: { name, arguments: args ?? {} } }, headers);
    assert.equal(response.status, 200, JSON.stringify(body));
    return { text: body.result.content[0].text, error: Boolean(body.result.isError) };
  };
  assert.equal((await fetch(`${base}/mcp`)).status, 405);
  let reply = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'meta-muse', version: '1' } } });
  const sessionId = reply.response.headers.get('mcp-session-id');
  assert.match(sessionId, /^[A-Za-z0-9_-]{32}$/);
  assert.match(reply.body.result.instructions, /cannot read files on the person's computer/);
  const museSession = { 'Mcp-Session-Id': sessionId };
  assert.equal((await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, museSession)).response.status, 202);
  reply = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, museSession);
  assert.deepEqual(reply.body.result.tools.map(item => item.name), ['link_account', 'list_plans', 'create_space', 'wait_for_payment', 'upload_files', 'finish_upload', 'space_status', 'set_visibility', 'unlink_account',
    'find_tour_spaces', 'list_tours', 'create_tour', 'draft_tour', 'wait_for_tour', 'get_tour', 'save_tour', 'search_models', 'share_tour']);
  assert.equal((await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { 'Mcp-Session-Id': 'x'.repeat(32) })).response.status, 404, 'unknown sessions re-initialize');
  assert.equal((await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { Authorization: 'Bearer nope' })).response.status, 401);
  assert.ok((await tool('space_status', {}, museSession)).error, 'nothing works before linking');

  const bob = new Browser();
  await signInWithGoogle(bob, { sub: 'bob-google', email: 'bob@example.com', email_verified: true, name: 'Bob' });
  result = await tool('link_account', {}, museSession);
  const muse = result.text.match(/\/account\/connect\/([B-Z2-9]{4}-[B-Z2-9]{4})/)[1];
  assert.ok(!/link_code/.test(result.text), 'a session keeps the code itself');
  assert.ok((await (await bob.get(`/account/connect/${muse}`)).text()).replaceAll('<!-- -->', '').includes('Link Meta Muse to your account'));
  assert.equal((await bob.post('/api/account/agents', { code: muse })).status, 200);
  result = await tool('link_account', {}, museSession);
  assert.match(result.text, /Linked to the SPHR account bob@example.com/);
  assert.ok(!/sphr_/.test(result.text), 'a session never shows the token');
  assert.match((await tool('list_plans', {}, museSession)).text, /Starter, \$8\.00 a month for up to 6 spaces/);
  result = await tool('create_space', { title: 'Harbor walk' }, museSession);
  const harbor = result.text.match(/space_id ([a-f0-9]{12})/)[1];
  const checkoutLink = result.text.match(/https:\/\/checkout\.example\/\S+/)[0];
  assert.ok(checkoutLink);
  const bobSession = [...stripeFake.state.sessions.values()].at(-1);
  stripeFake.state.pay(bobSession.id);
  await webhook({ id: 'evt_bob_paid', type: 'checkout.session.completed', data: { object: { id: bobSession.id } } });
  assert.match((await tool('wait_for_payment', { space_id: harbor }, museSession)).text, /Payment received/);
  assert.match((await tool('space_status', { space_id: harbor }, museSession)).text, new RegExp(`drop files at ${base}/account/spaces/${harbor}`));
  // Tours from the cloud: the same tools, with models by address.
  assert.equal((await tool('find_tour_spaces', { query: 'court' }, museSession)).text,
    '0b0b0b0b0b02: Garden court (SPHR space, a Gaussian splat)\n0b0b0b0b0b01: Temple court (SPHR space, 360 photos, 1 places to stand)', 'spaces say what kind of capture they are');
  result = await tool('create_tour', { scene_id: '0b0b0b0b0b01', kind: 'hunt', title: 'Offerings' }, museSession);
  const cloudTour = result.text.match(/tour_id ([a-f0-9]{12})/)[1];
  assert.match(result.text, /a scavenger hunt with 0 clues/);
  assert.match((await tool('search_models', { query: 'tripod' }, museSession)).text, /url https:\/\/models\.example\/tripod\.glb/);
  result = await tool('get_tour', { tour_id: cloudTour }, museSession);
  assert.match(result.text, /^noir \(Film noir\): /m);
  assert.match(result.text, /^confetti \(Confetti\): .* Params .*trigger one of stop\|found\|hint\|click default stop \(stop runs with its stop/m, 'the hosted get_tour lists the trigger too');
  result = await tool('save_tour', { tour_id: cloudTour, experience: { version: 1, kind: 'hunt', finale: 'All found.',
    objects: [{ id: 'tripod', name: 'Bronze tripod', source: { kind: 'model', url: 'https://models.example/tripod.glb' }, position: [1, 0, -2], rotation: [0, 0, 0], scale: [0.3, 0.3, 0.3] }],
    effects: [{ id: 'cheer', type: 'confetti', target: { kind: 'object', id: 'tripod' }, params: { palette: 'gold', trigger: 'found' } }],
    stops: [{ id: 'clue', title: 'By the altar', text: 'Something bronze hides near the altar.', format: 'plain', view: { nodeId: 'court-1' }, objects: ['tripod'], effects: ['cheer'],
      find: { objectId: 'tripod', hint: 'Look left.', found: 'Tripods held offerings.' } }] } }, museSession);
  assert.ok(!result.error, result.text);
  assert.match((await tool('get_tour', { tour_id: cloudTour }, museSession)).text, /"id":"cheer","type":"confetti","target":\{"kind":"object","id":"tripod"\},"params":\{[^}]*"trigger":"found"/, 'a celebration saved for the find keeps its trigger');
  assert.match((await tool('wait_for_tour', { tour_id: cloudTour }, museSession)).text, /Stops: 1\. By the altar/);
  assert.match((await tool('share_tour', { tour_id: cloudTour, title: 'Offerings at the altar' }, museSession)).text, /"Offerings at the altar".*private/);
  assert.match((await tool('list_tours', {}, museSession)).text, /Offerings at the altar/);
  assert.match((await tool('draft_tour', { tour_id: cloudTour, request: 'Make it a hunt for the tripod' }, museSession)).text, /working on it/);
  result = await tool('wait_for_tour', { tour_id: cloudTour }, museSession);
  assert.match(result.text, /The agent says: I placed the tripod/);
  assert.match(result.text, /a scavenger hunt with 1 clue/);

  // Without a session, the agent keeps the token itself and sends it as a bearer token.
  result = await tool('link_account', {});
  const statelessCode = result.text.match(/link_code "([a-f0-9]{64})"/)[1];
  const statelessUser = result.text.match(/\/account\/connect\/([B-Z2-9]{4}-[B-Z2-9]{4})/)[1];
  assert.equal((await bob.post('/api/account/agents', { code: statelessUser })).status, 200);
  result = await tool('link_account', { link_code: statelessCode });
  const cloudToken = result.text.match(/Bearer (sphr_[a-f0-9]{64})/)[1];
  const cloud = { Authorization: `Bearer ${cloudToken}` };
  const photo = randomBytes(9 * 1024 * 1024 + 7);
  result = await tool('upload_files', { space_id: harbor, files: [{ name: 'harbor-360.jpg', size: photo.length, type: 'image/jpeg' }] }, cloud);
  assert.ok(!result.error, result.text);
  const [started] = JSON.parse(result.text.slice(result.text.indexOf('[')));
  assert.equal(started.chunk_size, 8 * 1024 * 1024);
  result = await tool('finish_upload', { space_id: harbor }, cloud);
  assert.match(result.text, /Not every file is complete yet: harbor-360\.jpg \(0 bytes of/);
  for (let start = 0; start < photo.length; start += started.chunk_size) {
    const end = Math.min(start + started.chunk_size, photo.length) - 1;
    const put = await fetch(started.url, { method: 'PUT', body: photo.subarray(start, end + 1), headers: { ...cloud, 'Content-Range': `bytes ${start}-${end}/${photo.length}` } });
    assert.equal(put.status, end + 1 === photo.length ? 200 : 308);
  }
  result = await tool('finish_upload', { space_id: harbor, notes: 'Walk along the harbor at dusk.' }, cloud);
  assert.match(result.text, /Submitted for processing/);
  const harborSpace = (await (await bob.get(`/api/account/spaces/${harbor}`)).json()).space;
  assert.equal(harborSpace.status, 'queued');
  assert.equal(harborSpace.notes, 'Walk along the harbor at dusk.');
  assert.equal((await (await bob.get('/api/account/agents')).json()).agents.length, 2);
  assert.match((await tool('unlink_account', {}, museSession)).text, /Unlinked from bob@example.com/);
  assert.ok((await tool('space_status', {}, museSession)).error, 'an unlinked session must link again');
  assert.equal((await fetch(`${base}/mcp`, { method: 'DELETE', headers: museSession })).status, 204);
  assert.equal((await mcp({ jsonrpc: '2.0', id: 9, method: 'tools/list' }, museSession)).response.status, 404, 'a deleted session is gone');

  // The operator hears that agents were linked and that they added and submitted spaces.
  const field = (embed, name) => embed.fields.find(item => item.name === name)?.value;
  assert.ok(teamMessages.some(embed => embed.title === 'Agent linked' && /^Claude on /.test(field(embed, 'Agent')) && field(embed, 'Account') === 'alice@example.com'));
  assert.ok(teamMessages.some(embed => embed.title === 'Agent linked' && field(embed, 'Agent') === 'Meta Muse'));
  assert.ok(teamMessages.some(embed => embed.title === 'Space created' && field(embed, 'Title') === 'Riverside studio' && field(embed, 'From') === 'Their agent'));
  assert.ok(teamMessages.some(embed => embed.title === 'Space uploaded for processing' && field(embed, 'Title') === 'Riverside studio'
    && field(embed, 'From') === 'Their agent' && /^2 files, 18 MB$/.test(field(embed, 'Files'))));
  assert.equal(teamMessages.filter(embed => embed.title === 'New subscription').length, 2, 'Alice and Bob each subscribed once');

  console.log('Agent connector: linking, plans, Checkout, background upload, submission, tours with looks, library search and Blender models, and unlinking all passed.');
  console.log('Hosted endpoint: session and bearer linking, Checkout, resumable uploads, submission, tours and unlinking all passed.');
} catch (error) {
  console.error(error);
  console.error(appLog.split('\n').slice(-60).join('\n'));
  process.exitCode = 1;
} finally {
  await cleanup();
}
