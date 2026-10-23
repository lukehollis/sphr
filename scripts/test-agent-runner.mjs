// The processing runner against a stand-in application: a job whose agent never starts goes back to the queue
// instead of failing the customer's space, and real results are reported as before.
//   node --test scripts/test-agent-runner.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./worker/agent-runner.mjs', import.meta.url));

// A one-chunk DAM naming texture 000, as Matterport serves its dollhouse mesh.
const field = (number, bytes) => Buffer.concat([Buffer.from([number * 8 + 2, bytes.length]), bytes]);
const dam = field(1, Buffer.concat([field(1, Buffer.alloc(0)), field(4, Buffer.from('m_50k_000.jpg'))]));

/** Matterport's model graph and CDN, served from the stand-in application's own address. `model` is 'ok', 'missing' or 'down'. */
function fakeMatterport(origin, model, request, text, response) {
  if (model === 'down') { response.writeHead(503); return response.end('busy'); }
  const body = JSON.parse(text);
  const cdn = `${origin}/cdn`;
  const answer = body.operationName === 'GetMattertags' ? { data: { model: { id: 'MD4iVby1G8k', mattertags: [] } } }
    : model === 'missing' ? { data: { root: null, model: null }, errors: [{ message: 'Not Found' }] }
    : { data: { root: { id: 'MD4iVby1G8k', name: 'Pyramid' }, model: { id: 'MD4iVby1G8k', locations: [{ id: 'l1', index: 0, neighbors: [],
      pano: { sweepUuid: 's1', skyboxes: [{ resolution: '2k', status: 'available', urlTemplate: `${cdn}/pan/2k/~/s1_skybox<face>.jpg?t=signed` }] } }],
      assets: { meshes: [{ id: 'm', status: 'available', format: 'dam', resolution: '50k', url: `${cdn}/m_50k.dam?t=signed` }],
        textures: [{ status: 'available', quality: 'high', resolution: '50k', urlTemplate: `${cdn}/~/tex/m_50k_<texture>.jpg?t=signed` }] } } } };
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(answer));
}

/**
 * One queued job with a five-byte upload, or, with `matterport`, a space made from a Matterport link (served by the
 * same stand-in); counts downloads and records every action and health check the runner posts. `refuse` answers the
 * first `times` posts of one action with `status`, as a proxy or a restarting application would.
 */
async function fakeApp({ defer = true, matterport, refuse } = {}) {
  const job = { id: '0123456789abcdef', status: 'queued', sceneId: 'abcdef123456', slug: 'customer-abc123def456', preview: false,
    space: { id: 'abc123def456', title: 'Test space', notes: null, output: 'auto', reprocessing: false },
    uploads: matterport ? [] : [{ id: 'u1', name: 'capture.zip', size: 5, type: 'application/zip', source: { url: '/api/worker/uploads/u1' } }],
    source: matterport ? { kind: 'matterport', modelId: 'MD4iVby1G8k', url: 'https://my.matterport.com/show/?m=MD4iVby1G8k' } : null };
  const app = { actions: [], downloads: 0, health: [] };
  const server = createServer(async (request, response) => {
    const send = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (request.url.startsWith('/api/worker/uploads/')) { app.downloads++; response.writeHead(200); return response.end('hello'); }
    if (request.url.startsWith('/cdn/')) { response.writeHead(200); return response.end(request.url.includes('.dam') ? dam : 'image'); }
    if (request.url === '/api/mp/models/graph') {
      let graph = '';
      for await (const chunk of request) graph += chunk;
      return fakeMatterport(app.origin, matterport, request, graph, response);
    }
    if (request.method === 'GET') return send(200, { jobs: job.status === 'queued' ? [job] : [] });
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    if (request.url === '/api/worker/health') { app.health.push(body); return send(200, { ok: true }); }
    if (body.action !== 'progress') app.actions.push(body);
    if (refuse && body.action === refuse.action && refuse.times-- > 0) {
      response.writeHead(refuse.status, { 'Content-Type': 'text/html' });
      return response.end('<html><title>Attention Required!</title></html>');
    }
    if (body.action === 'claim') { job.status = 'running'; return send(200, { job }); }
    if (body.action === 'defer' && !defer) return send(400, { error: 'Unknown action.' });
    job.status = ['defer', 'release'].includes(body.action) ? 'queued' : body.action;
    send(200, { ok: true, job });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  app.origin = `http://127.0.0.1:${server.address().port}`;
  app.close = () => new Promise(resolve => server.close(resolve));
  return app;
}

const fakeAgent = fileURLToPath(new URL('./test-support/fake-agent.mjs', import.meta.url));
// The stand-in agent builds a real package with sharp; a worker's checkout may run without the app's dependencies.
const packages = existsSync(fileURLToPath(new URL('../node_modules/sharp', import.meta.url))) || 'the stand-in agent needs npm ci (sharp)';

/** Runs one pass of the runner with `command` as the agent command; `options.env` adds to its environment. */
async function runOnce(command, options = {}) {
  const app = await fakeApp(options);
  const dir = mkdtempSync(path.join(tmpdir(), 'sphr-runner-test-'));
  try {
    const child = spawn(process.execPath, [runner, 'run', '--once'], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH,
      SPHR_WORKER_URL: app.origin, SPHR_WORKER_TOKEN: 'x'.repeat(40), SPHR_WORKER_NAME: 'test-worker', SPHR_WORKER_DIR: dir,
      SPHR_AGENT_ISOLATION: 'container', SPHR_AGENT_COMMAND: JSON.stringify(command), SPHR_WORKER_DISK_RESERVE_GB: '0',
      SPHR_MATTERPORT_TEST_BASE: app.origin, SPHR_WORKER_REPORT_RETRY_MS: '20', SPHR_WORKER_PUBLISH: 'local',
      SPHR_WORKER_LOCAL_DATASETS: path.join(dir, 'published'), ...options.env } });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise(resolve => child.on('exit', resolve));
    return { ...app, code, output };
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const actions = run => run.actions.map(action => action.action);

test('a job whose agent never starts goes back to the queue, and the operator hears why', async () => {
  const run = await runOnce(['sh', '-c', 'echo "docker: Error response from daemon: pull access denied for sphr-agent-gpu" >&2; exit 125']);
  assert.deepEqual(actions(run), ['claim', 'defer'], run.output);
  assert.match(run.actions[1].message, /exited with 125 before writing anything: docker: Error response from daemon: pull access denied/);
  assert.equal(run.code, 0, run.output);
});

test('a missing agent image is found before anything is downloaded', async () => {
  const run = await runOnce(['docker', 'run', '--rm', '--network', 'none', '-e', 'HOME', 'sphr-runner-test-no-such-image', 'claude', '-p', '{prompt}']);
  assert.deepEqual(actions(run), ['claim', 'defer'], run.output);
  assert.match(run.actions[1].message, /test-worker cannot start agents: the agent image sphr-runner-test-no-such-image is missing/);
  assert.equal(run.downloads, 0);
});

test('an application without defer gets the job released', async () => {
  const run = await runOnce(['sh', '-c', 'exit 125'], { defer: false });
  assert.deepEqual(actions(run), ['claim', 'defer', 'release'], run.output);
});

test('a capture the agent rejects is still reported to the customer', async () => {
  const run = await runOnce(['sh', '-c', 'printf \'{"status":"failed","message":"Upload a capture."}\' > output/result.json']);
  assert.deepEqual(actions(run), ['claim', 'fail'], run.output);
  assert.equal(run.actions[1].message, 'Upload a capture.');
});

test('an agent that started work and stopped without a result is still held for an operator', async () => {
  const run = await runOnce(['sh', '-c', 'echo "Found 3 photos" >> output/progress.log; exit 1']);
  assert.deepEqual(actions(run), ['claim', 'hold'], run.output);
});

test('a job too big for the free disk waits instead of failing halfway, before anything is downloaded', async () => {
  const run = await runOnce(['sh', '-c', 'exit 0'], { env: { SPHR_WORKER_DISK_RESERVE_GB: '1000000' } });
  assert.deepEqual(actions(run), ['claim', 'defer'], run.output);
  assert.match(run.actions[1].message, /test-worker is short of disk space: only [\d.]+ GB is free on this worker and this job needs about/);
  assert.equal(run.downloads, 0);
});

test('the worker tells the application whether it can start agents', async () => {
  const healthy = await runOnce(['sh', '-c', 'exit 125']);
  assert.deepEqual(healthy.health, [{ worker: 'test-worker', problem: null }], healthy.output);
  const broken = await runOnce(['docker', 'run', '--rm', 'sphr-runner-test-no-such-image', 'true']);
  assert.equal(broken.health.length, 1, broken.output);
  assert.match(broken.health[0].problem, /the agent image sphr-runner-test-no-such-image is missing/);
});

test('a Matterport link is downloaded by the runner, and the agent finds the space in its input', async () => {
  const look = 'test -f input/matterport-MD4iVby1G8k/link.json && grep -q \'"modelId": "MD4iVby1G8k"\' job.json'
    + ' && printf \'{"status":"failed","message":"found %s files"}\' "$(find input/matterport-MD4iVby1G8k -type f | wc -l | tr -d " ")" > output/result.json';
  const run = await runOnce(['sh', '-c', look], { matterport: 'ok' });
  assert.deepEqual(actions(run), ['claim', 'fail'], run.output);
  // Six faces, the mesh and its texture, the tags, index.html and link.json.
  assert.equal(run.actions[1].message, 'found 11 files', run.output);
  assert.equal(run.downloads, 0, 'no uploads to fetch');
});

test('a Matterport space that does not open is reported to the customer without starting the agent', async () => {
  const run = await runOnce(['sh', '-c', 'echo started > output/progress.log'], { matterport: 'missing' });
  assert.deepEqual(actions(run), ['claim', 'fail'], run.output);
  assert.match(run.actions[1].message, /did not open\. It may be private, need a password, or no longer exist\. Make it public or unlisted on Matterport/);
});

test('a Matterport that cannot be reached gives the job back for later', async () => {
  const run = await runOnce(['sh', '-c', 'exit 0'], { matterport: 'down' });
  assert.deepEqual(actions(run), ['claim', 'defer'], run.output);
  assert.match(run.actions[1].message, /Matterport answered 503/);
  assert.match(run.output, /Matterport turned this worker away: .*Matterport links wait until/, 'the links waiting to come from Matterport wait together');
});

test('a result the application cannot take at first is sent again, not left running for hours', async () => {
  const run = await runOnce(['sh', '-c', 'printf \'{"status":"failed","message":"Upload a capture."}\' > output/result.json'], { refuse: { action: 'fail', times: 2, status: 503 } });
  assert.deepEqual(actions(run), ['claim', 'fail', 'fail', 'fail'], run.output);
  assert.match(run.output, /could not report "fail" \(HTTP 503\); trying again/);
  assert.equal(run.code, 0, run.output);
});

test('a published space whose report is refused waits for an operator, with how to report it again', { skip: packages === true ? false : packages }, async () => {
  const run = await runOnce([process.execPath, fakeAgent, '{job}'], { refuse: { action: 'complete', times: 1, status: 403 } });
  assert.deepEqual(actions(run), ['claim', 'complete', 'hold'], run.output);
  assert.match(run.actions[2].message, /^The space was published, but reporting it was refused \(HTTP 403\)\. Report it again with: agent-runner\.mjs publish 0123456789abcdef$/);
});
