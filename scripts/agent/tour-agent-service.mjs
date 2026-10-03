#!/usr/bin/env node
// A local HTTP front for an agent CLI that is logged in on this machine, so the
// web app can draft tours without holding the agent's credentials or running it
// inside its own memory limits. The CLI runs with no tools: images arrive as
// content blocks on stdin, and only the model's text comes back.
//
//   SPHR_TOUR_AGENT_SERVICE_TOKEN=<32+ chars> node scripts/agent/tour-agent-service.mjs
//
// Environment: SPHR_TOUR_AGENT_SERVICE_PORT (3037), SPHR_TOUR_AGENT_CLAUDE (claude),
// SPHR_TOUR_AGENT_SERVICE_MODEL (opus), SPHR_TOUR_AGENT_SERVICE_TIMEOUT_MS (300000).
// The app sets SPHR_TOUR_AGENT_URL=http://127.0.0.1:3037 and the same token.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';

const token = process.env.SPHR_TOUR_AGENT_SERVICE_TOKEN ?? '';
if (token.length < 32) { console.error('Set SPHR_TOUR_AGENT_SERVICE_TOKEN to at least 32 characters.'); process.exit(1); }
const port = Number(process.env.SPHR_TOUR_AGENT_SERVICE_PORT ?? 3037);
const claude = process.env.SPHR_TOUR_AGENT_CLAUDE ?? 'claude';
const model = process.env.SPHR_TOUR_AGENT_SERVICE_MODEL ?? 'opus';
const timeout = Number(process.env.SPHR_TOUR_AGENT_SERVICE_TIMEOUT_MS ?? 300000);
const digest = (value) => createHash('sha256').update(value).digest();
const authorized = (request) => {
  const supplied = /^Bearer (\S{1,512})$/.exec(request.headers.authorization ?? '')?.[1];
  return Boolean(supplied) && timingSafeEqual(digest(supplied), digest(token));
};

let running = 0;
const waiting = [];
const slot = () => new Promise((resolve) => { if (running < 1) { running += 1; resolve(); } else waiting.push(resolve); });
const release = () => { const next = waiting.shift(); if (next) next(); else running -= 1; };

function compose({ system, prompt, images }) {
  const content = [];
  for (const image of images ?? []) {
    content.push({ type: 'text', text: String(image.label ?? '') });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: String(image.data ?? '') } });
  }
  content.push({ type: 'text', text: String(prompt) });
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--tools', '',
    '--model', model, '--no-session-persistence', '--strict-mcp-config', ...(system ? ['--system-prompt', String(system)] : [])];
  return new Promise((resolve, reject) => {
    const child = spawn(claude, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DISABLE_AUTOUPDATER: '1' } });
    let buffer = '';
    let result = null;
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('The agent took too long.')); }, timeout);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try { const event = JSON.parse(line); if (event.type === 'result') result = event; } catch { /* not JSON */ }
      }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', () => {
      clearTimeout(timer);
      if (!result) return reject(new Error(`The agent stopped without an answer. ${stderr.trim().split('\n').slice(-1)[0] ?? ''}`.trim()));
      if (result.is_error) return reject(new Error(String(result.result ?? 'The agent reported an error.').slice(0, 400)));
      resolve(String(result.result ?? ''));
    });
    child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
  });
}

createServer((request, response) => {
  const send = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
  if (request.method === 'GET' && request.url === '/health') return send(200, { ok: true, running, waiting: waiting.length });
  if (request.method !== 'POST' || request.url !== '/compose') return send(404, { error: 'Not found.' });
  if (!authorized(request)) return send(401, { error: 'Unauthorized.' });
  if (waiting.length >= 4) return send(429, { error: 'The agent is busy. Try again in a minute.' });
  const chunks = [];
  let size = 0;
  request.on('data', (chunk) => { size += chunk.length; if (size > 24 * 1024 * 1024) request.destroy(); else chunks.push(chunk); });
  request.on('end', async () => {
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { error: 'Invalid request.' }); }
    if (typeof body?.prompt !== 'string' || !body.prompt) return send(400, { error: 'Missing prompt.' });
    await slot();
    try { send(200, { output: await compose(body) }); }
    catch (error) { send(502, { error: error instanceof Error ? error.message : 'The agent failed.' }); }
    finally { release(); }
  });
}).listen(port, '127.0.0.1', () => console.log(`tour agent service on 127.0.0.1:${port} using ${claude} (${model})`));
