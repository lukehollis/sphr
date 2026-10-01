// End-to-end: a person's own agent links to their account through the connector (connector/server.mjs,
// driven over MCP stdio as Claude or Codex would), pays through Checkout, uploads a capture from
// disk in the background and submits it. A real Next development server runs against local
// stand-ins for Stripe, Google and email. Nothing leaves this machine.
//   node scripts/test-agent-connector.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';
import { fakeIdentityProvider, fakeStripe, listen, smtpSink } from './test-support/fake-services.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
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

const env = { ...process.env, SPHR_BUILD_DIR: '.next-agent-test', SPHR_PUBLIC_URL: base, SPHR_STATE_DIR: state,
  SPHR_ACCESS_CONTROL: '1', SPHR_ACCOUNTS: '1', SPHR_CATALOG_URL: '', SPHR_ASSET_BASE_URL: '', NEXT_PUBLIC_SPHR_ASSET_BASE_URL: '',
  SPHR_SMTP_URL: `smtp://127.0.0.1:${mail.port}`, SPHR_MAIL_FROM: 'Spaces <no-reply@example.com>',
  SPHR_OAUTH_TEST_BASE: idpServer.base, SPHR_GOOGLE_CLIENT_ID: clients.google.id, SPHR_GOOGLE_CLIENT_SECRET: clients.google.secret,
  SPHR_STRIPE_SECRET_KEY: 'sk_test_fake', SPHR_STRIPE_PRICE_ID: 'price_space', SPHR_STRIPE_WEBHOOK_SECRET: webhookSecret, SPHR_STRIPE_TEST_API: stripeServer.base,
  SPHR_STRIPE_PLAN_PRICES: 'price_starter,price_pro,price_enterprise', SPHR_WORKER_TOKEN: randomBytes(24).toString('hex'),
  SPHR_UPLOAD_MAX_GB: '1', SPHR_UPLOAD_BUCKET: '', SPHR_DISCORD_WEBHOOK_URL: `${teamHook.base}/hook` };
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
  assert.deepEqual(listed, ['link_account', 'check_files', 'list_plans', 'create_space', 'wait_for_payment', 'upload_files', 'space_status', 'set_visibility', 'unlink_account']);
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
  assert.deepEqual(reply.body.result.tools.map(item => item.name), ['link_account', 'list_plans', 'create_space', 'wait_for_payment', 'upload_files', 'finish_upload', 'space_status', 'set_visibility', 'unlink_account']);
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
    && field(embed, 'From') === 'Their agent' && /^2 files, 17\.\d MB$/.test(field(embed, 'Files'))));
  assert.equal(teamMessages.filter(embed => embed.title === 'New subscription').length, 2, 'Alice and Bob each subscribed once');

  console.log('Agent connector: linking, plans, Checkout, background upload, submission and unlinking all passed.');
  console.log('Hosted endpoint: session and bearer linking, Checkout, resumable uploads, submission and unlinking all passed.');
} catch (error) {
  console.error(error);
  console.error(appLog.split('\n').slice(-60).join('\n'));
  process.exitCode = 1;
} finally {
  await cleanup();
}
