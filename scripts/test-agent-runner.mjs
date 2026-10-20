// The processing runner against a stand-in application: a job whose agent never starts goes back to the queue
// instead of failing the customer's space, and real results are reported as before.
//   node --test scripts/test-agent-runner.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./worker/agent-runner.mjs', import.meta.url));

/** One queued job with a five-byte upload; counts downloads and records every action and health check the runner posts. */
async function fakeApp({ defer = true } = {}) {
  const job = { id: '0123456789abcdef', status: 'queued', sceneId: 'abcdef123456', slug: 'customer-abc123def456', preview: false,
    space: { id: 'abc123def456', title: 'Test space', notes: null, output: 'auto', reprocessing: false },
    uploads: [{ id: 'u1', name: 'capture.zip', size: 5, type: 'application/zip', source: { url: '/api/worker/uploads/u1' } }] };
  const app = { actions: [], downloads: 0, health: [] };
  const server = createServer(async (request, response) => {
    const send = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (request.url.startsWith('/api/worker/uploads/')) { app.downloads++; response.writeHead(200); return response.end('hello'); }
    if (request.method === 'GET') return send(200, { jobs: job.status === 'queued' ? [job] : [] });
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    if (request.url === '/api/worker/health') { app.health.push(body); return send(200, { ok: true }); }
    if (body.action !== 'progress') app.actions.push(body);
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

/** Runs one pass of the runner with `command` as the agent command; `options.env` adds to its environment. */
async function runOnce(command, options = {}) {
  const app = await fakeApp(options);
  const dir = mkdtempSync(path.join(tmpdir(), 'sphr-runner-test-'));
  try {
    const child = spawn(process.execPath, [runner, 'run', '--once'], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH,
      SPHR_WORKER_URL: app.origin, SPHR_WORKER_TOKEN: 'x'.repeat(40), SPHR_WORKER_NAME: 'test-worker', SPHR_WORKER_DIR: dir,
      SPHR_AGENT_ISOLATION: 'container', SPHR_AGENT_COMMAND: JSON.stringify(command), SPHR_WORKER_DISK_RESERVE_GB: '0', ...options.env } });
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
