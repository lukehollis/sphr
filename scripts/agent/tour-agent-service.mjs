#!/usr/bin/env node
// A local HTTP front for an agent CLI that is logged in on this machine, so the
// web app can draft tours without holding the agent's credentials or running it
// inside its own memory limits. The CLI runs with no built-in tools: images arrive
// as content blocks on stdin, and only the model's text comes back. With
// SPHR_LIBRARY_SEARCH_URL set it gets one read-only MCP tool, search_models,
// served by library-mcp.mjs beside this file.
//
//   SPHR_TOUR_AGENT_SERVICE_TOKEN=<32+ chars> node scripts/agent/tour-agent-service.mjs
//
// Environment: SPHR_TOUR_AGENT_SERVICE_PORT (3037), SPHR_TOUR_AGENT_CLAUDE (claude),
// SPHR_TOUR_AGENT_SERVICE_MODEL (opus), SPHR_TOUR_AGENT_SERVICE_TIMEOUT_MS (300000),
// SPHR_LIBRARY_SEARCH_URL (the site's /api/library/search, for the search_models tool) and
// SPHR_LIBRARY_SEARCH_LOG (a file that records each search the agent makes).
// The app sets SPHR_TOUR_AGENT_URL=http://127.0.0.1:3037 and the same token.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const token = process.env.SPHR_TOUR_AGENT_SERVICE_TOKEN ?? '';
if (token.length < 32) { console.error('Set SPHR_TOUR_AGENT_SERVICE_TOKEN to at least 32 characters.'); process.exit(1); }
const port = Number(process.env.SPHR_TOUR_AGENT_SERVICE_PORT ?? 3037);
const claude = process.env.SPHR_TOUR_AGENT_CLAUDE ?? 'claude';
const isAgy = /(?:^|\/)agy(?:$|-)/.test(claude);
const model = process.env.SPHR_TOUR_AGENT_SERVICE_MODEL ?? (isAgy ? 'gemini-4-argon-high' : 'opus');
const fallback3pModel = process.env.SPHR_TOUR_AGENT_FALLBACK_3P_MODEL ?? 'claude-sonnet-5-5-high';
const apiKeyModel = process.env.SPHR_TOUR_AGENT_APIKEY_MODEL ?? 'gemini-3.8-flash-high';
const geminiApiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
const timeout = Number(process.env.SPHR_TOUR_AGENT_SERVICE_TIMEOUT_MS ?? 300000);
const digest = (value) => createHash('sha256').update(value).digest();
const authorized = (request) => {
  const supplied = /^Bearer (\S{1,512})$/.exec(request.headers.authorization ?? '')?.[1];
  return Boolean(supplied) && timingSafeEqual(digest(supplied), digest(token));
};

// Configure Antigravity homes and multi-tier fallback waterfall (OAuth Gemini + G1 Credits -> OAuth 3P Claude -> Paid GEMINI_API_KEY).
const baseHome = process.env.HOME || tmpdir();
const apiKeyHome = path.join(baseHome, '.apikey-home');
if (isAgy) {
  try {
    const mainSettingsPath = path.join(baseHome, '.gemini/antigravity-cli/settings.json');
    if (existsSync(mainSettingsPath)) {
      const parsed = JSON.parse(readFileSync(mainSettingsPath, 'utf8'));
      if (parsed.useG1Credits !== true) {
        parsed.useG1Credits = true;
        writeFileSync(mainSettingsPath, JSON.stringify(parsed, null, 2));
      }
    }
    if (geminiApiKey) {
      const apiCliDir = path.join(apiKeyHome, '.gemini/antigravity-cli');
      mkdirSync(apiCliDir, { recursive: true });
      const mainConfigDir = path.join(baseHome, '.gemini/config');
      const apiConfigLink = path.join(apiKeyHome, '.gemini/config');
      if (existsSync(mainConfigDir) && !existsSync(apiConfigLink)) symlinkSync(mainConfigDir, apiConfigLink);
      const mainMcpConfig = path.join(baseHome, '.gemini/config/mcp_config.json');
      const apiMcpLink = path.join(apiCliDir, 'mcp_config.json');
      if (existsSync(mainMcpConfig) && !existsSync(apiMcpLink)) symlinkSync(mainMcpConfig, apiMcpLink);
      const mainState = path.join(baseHome, '.gemini/antigravity-cli/jetski_state.pbtxt');
      const apiState = path.join(apiCliDir, 'jetski_state.pbtxt');
      if (existsSync(mainState)) copyFileSync(mainState, apiState);
      writeFileSync(path.join(apiCliDir, 'settings.json'), JSON.stringify({
        allowNonWorkspaceAccess: true,
        artifactReviewPolicy: 'always-proceed',
        model: 'Gemini 3.8 Flash (High)',
        modelProvider: 'gemini',
        toolPermission: 'always-proceed'
      }, null, 2));
    }
  } catch (err) {
    console.warn('Warning: unable to initialize agy fallback homes:', err instanceof Error ? err.message : err);
  }
}

const agyTiers = isAgy ? [
  { id: 'oauth-gemini', label: 'Antigravity account (Gemini)', model, home: baseHome, apiKey: false },
  { id: 'oauth-3p', label: 'Antigravity account (Claude bucket)', model: fallback3pModel, home: baseHome, apiKey: false },
  ...(geminiApiKey ? [
    { id: 'apikey-gemini-flash', label: 'Gemini API key (Flash)', model: apiKeyModel, home: apiKeyHome, apiKey: true },
    { id: 'apikey-gemini-pro', label: 'Gemini API key (Pro)', model: 'gemini-3.1-pro-high', home: apiKeyHome, apiKey: true }
  ] : [])
] : [];
const tierCooldownUntil = new Map();
const COOLDOWN_MS = 15 * 60 * 1000;

function orderedAgyTiers() {
  const now = Date.now();
  const ready = agyTiers.filter((t) => (tierCooldownUntil.get(t.id) ?? 0) <= now);
  const cooling = agyTiers.filter((t) => (tierCooldownUntil.get(t.id) ?? 0) > now);
  return [...ready, ...cooling];
}

// The library tool, when configured: one MCP server, and only its one tool allowed.
const librarySearch = process.env.SPHR_LIBRARY_SEARCH_URL ?? '';
const libraryServer = path.join(path.dirname(fileURLToPath(import.meta.url)), 'library-mcp.mjs');
const mcpConfig = !isAgy && librarySearch && existsSync(libraryServer) ? (() => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'sphr-tour-agent-')), 'mcp.json');
  const env = { SPHR_LIBRARY_SEARCH_URL: librarySearch, ...(process.env.SPHR_LIBRARY_SEARCH_LOG ? { SPHR_LIBRARY_SEARCH_LOG: process.env.SPHR_LIBRARY_SEARCH_LOG } : {}) };
  writeFileSync(file, JSON.stringify({ mcpServers: { library: { command: process.execPath, args: [libraryServer], env } } }), { mode: 0o600 });
  return file;
})() : null;

let running = 0;
const waiting = [];
// Two drafts at a time (each CLI takes a few hundred MB); the rest wait their turn.
const concurrent = Math.max(1, Number(process.env.SPHR_TOUR_AGENT_SERVICE_CONCURRENCY ?? 2));
const slot = () => new Promise((resolve) => { if (running < concurrent) { running += 1; resolve(); } else waiting.push(resolve); });
const release = () => { const next = waiting.shift(); if (next) next(); else running -= 1; };

function runAgyTier(tier, directory, fullPrompt, labelByFile, onLog) {
  const customAgent = existsSync(path.join(tier.home, '.gemini/config/agents/tour-drafter/agent.md'));
  const args = ['-p=', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--model', tier.model, '--dangerously-skip-permissions', '--disable-slash-commands',
    ...(customAgent ? ['--agent', 'tour-drafter'] : [])];
  const childEnv = { ...process.env, HOME: tier.home, DISABLE_AUTOUPDATER: '1' };
  if (tier.apiKey) {
    childEnv.GEMINI_API_KEY = geminiApiKey;
    delete childEnv.GOOGLE_API_KEY;
  } else {
    delete childEnv.GEMINI_API_KEY;
    delete childEnv.GOOGLE_API_KEY;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(claude, args, { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv });
    let buffer = '';
    let result = null;
    let conversationId = '';
    let stderr = '';
    let draftBuffer = '';
    let startedWriting = false;
    let loggedPlanning = false;
    const seenTitles = new Set();
    const cleanupConv = () => {
      if (conversationId && /^[0-9a-f-]{36}$/i.test(conversationId) && tier.home) {
        rmSync(path.join(tier.home, '.gemini/antigravity-cli/brain', conversationId), { recursive: true, force: true });
        rmSync(path.join(tier.home, '.gemini/antigravity-cli/conversations', `${conversationId}.pb`), { force: true });
      }
    };
    const timer = setTimeout(() => { child.kill('SIGTERM'); cleanupConv(); reject(new Error('The agent took too long.')); }, timeout);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          if (event.conversation_id) conversationId = String(event.conversation_id);
          if (event.event === 'init') {
            onLog?.(`Agent started (${event.init?.model || tier.model}) — analyzing space layout and request…`);
          } else if (event.event === 'step_update' && event.step_update) {
            const step = event.step_update;
            if (step.step_type === 'tool') {
              const info = step.tool_info ?? {};
              const params = info.parameters ?? {};
              const isSearch = step.tool_name === 'call_mcp_tool' || String(step.tool_name).includes('search_models');
              if (step.state === 'ACTIVE') {
                if (isSearch) {
                  const q = params.Arguments?.query ?? params.query ?? '';
                  if (q) onLog?.(`Searching 3D model library for "${q}"…`);
                } else if (step.tool_name === 'view_file') {
                  const base = path.basename(String(params.AbsolutePath ?? ''));
                  const label = labelByFile.get(base) || base || 'space view';
                  onLog?.(`Inspecting space photo: ${label}…`);
                }
              } else if (step.state === 'DONE' && isSearch && typeof info.output === 'string') {
                const q = params.Arguments?.query ?? params.query ?? '';
                if (info.output.startsWith('No models match')) {
                  onLog?.(`No library models matched "${q}" — trying another search…`);
                } else {
                  const lines = info.output.trim().split('\n').filter(Boolean);
                  const sample = lines.slice(0, 3).map((l) => l.split(':')[0]?.trim()).filter(Boolean).join(', ');
                  onLog?.(`Found ${lines.length} matching 3D model${lines.length === 1 ? '' : 's'}${sample ? ` (${sample}${lines.length > 3 ? ', …' : ''})` : ''}`);
                }
              }
            } else if (step.step_type === 'agent_response') {
              if (typeof step.text_delta === 'string' && step.text_delta) {
                draftBuffer += step.text_delta;
                if (!startedWriting && draftBuffer.includes('{')) {
                  startedWriting = true;
                  onLog?.('Writing stops, clues, and 3D object placements…');
                }
                const titleRegex = /"title"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g;
                let match;
                while ((match = titleRegex.exec(draftBuffer)) !== null) {
                  const title = match[1].replace(/\\"/g, '"').trim();
                  if (title && !seenTitles.has(title)) {
                    seenTitles.add(title);
                    onLog?.(`Drafted: "${title}"`);
                  }
                }
              } else if (step.state === 'DONE' && step.usage?.thinking_tokens > 0 && !startedWriting && !loggedPlanning) {
                loggedPlanning = true;
                onLog?.('Planning route and 3D placements across the space…');
              }
            }
          } else if (event.event === 'result' && event.result) {
            const r = event.result;
            if (r.conversation_id) conversationId = String(r.conversation_id);
            result = {
              is_error: r.status !== 'SUCCESS',
              result: r.status === 'SUCCESS' ? String(r.response ?? '') : String(r.error || r.response || 'The agent reported an error.')
            };
          }
        } catch { /* not JSON */ }
      }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    child.on('error', (error) => { clearTimeout(timer); cleanupConv(); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      cleanupConv();
      const stderrTail = stderr.trim().split('\n').slice(-2).join(' ');
      if (!result) return reject(new Error(`The agent stopped without an answer (code ${code ?? 'unknown'}). ${stderrTail}`.trim()));
      if (result.is_error) return reject(new Error(`${String(result.result ?? 'The agent reported an error.')} ${stderrTail}`.trim().slice(0, 500)));
      const out = String(result.result ?? '');
      if (!out.includes('{') || !out.includes('"stops"')) {
        return reject(new Error(`The agent did not return a JSON draft: ${out.slice(0, 240)} ${stderrTail}`.trim()));
      }
      resolve(out);
    });
    child.stdin.end(JSON.stringify({ event: 'user', message: { role: 'user', content: fullPrompt } }) + '\n');
  });
}

async function compose({ system, prompt, images }, onLog) {
  if (isAgy) {
    const directory = mkdtempSync(path.join(tmpdir(), 'sphr-tour-agent-'));
    try {
      const labelByFile = new Map();
      const names = (images ?? []).map((image, index) => {
        const label = String(image.label ?? `view-${index + 1}`);
        const slug = label.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-|-$/g, '').slice(0, 48) || 'view';
        const base = `${String(index + 1).padStart(2, '0')}-${slug}.jpg`;
        const file = path.join(directory, base);
        writeFileSync(file, Buffer.from(String(image.data ?? ''), 'base64'));
        labelByFile.set(base, label);
        return `${file} (${label})`;
      });
      const fullPrompt = [
        system ? String(system) : '',
        'Tool notes for this environment:',
        '- Pre-matched 3D models (`lib1`..`libN`) are already listed in the prompt below. Prefer those codes whenever they fit.',
        '- To search the 3D model library (`search_models`) for anything not already listed, call `call_mcp_tool` with `ServerName: "library"`, `ToolName: "search_models"`, and `Arguments: { "query": "..." }`.',
        names.length ? `- Images of the space are saved in ${directory}. Inspect 8–12 key views spread across different locations of the space with \`view_file\` using \`AbsolutePath\`:\n  ${names.join('\n  ')}` : '',
        '- Create at least 7 stops (or at least 7 clues in a scavenger hunt) spread across different locations in the space, unless the user explicitly asks for a shorter tour/hunt.',
        '- SPEED IS CRITICAL: Batch all `view_file` and `search_models` calls together in ONE single parallel tool-call turn, keep your internal thinking brief (under 250 words), and output the JSON draft immediately in the next turn.',
        '- Do not write or edit files or run shell commands. Reply with ONLY the single JSON object matching the schema.',
        String(prompt)
      ].filter(Boolean).join('\n\n');

      const tiers = orderedAgyTiers();
      let lastError = null;
      for (let i = 0; i < tiers.length; i += 1) {
        const tier = tiers[i];
        try {
          const output = await runAgyTier(tier, directory, fullPrompt, labelByFile, onLog);
          tierCooldownUntil.delete(tier.id);
          return output;
        } catch (error) {
          lastError = error;
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[tour-agent] tier ${tier.id} (${tier.model}) failed: ${message}`);
          if (/(quota|credit|resource_exhausted|rate.?limit|429|exhausted|too low|unauthenticated|unauthorized|expired|sign in|login|code 3)/i.test(message)) {
            tierCooldownUntil.set(tier.id, Date.now() + COOLDOWN_MS);
          }
          const next = tiers[i + 1];
          if (next) {
            onLog?.(`Switching to fallback model (${next.model})…`);
          }
        }
      }
      throw lastError ?? new Error('The agent could not finish.');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  const content = [];
  for (const image of images ?? []) {
    content.push({ type: 'text', text: String(image.label ?? '') });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: String(image.data ?? '') } });
  }
  content.push({ type: 'text', text: String(prompt) });
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--tools', '',
    '--model', model, '--no-session-persistence', '--strict-mcp-config',
    ...(mcpConfig ? ['--mcp-config', mcpConfig, '--allowedTools', 'mcp__library__search_models'] : []),
    ...(system ? ['--system-prompt', String(system)] : [])];
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
        try {
          const event = JSON.parse(line);
          if (event.type === 'system' && event.subtype === 'init') onLog?.(`Agent started (${model}) — analyzing space layout and request…`);
          if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
            for (const block of event.message.content) {
              if (block.type === 'tool_use' && block.input?.query) onLog?.(`Searching 3D model library for "${block.input.query}"…`);
            }
          }
          if (event.type === 'result') result = event;
        } catch { /* not JSON */ }
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
  if (request.method === 'GET' && request.url === '/health') {
    const now = Date.now();
    return send(200, {
      ok: true,
      running,
      waiting: waiting.length,
      ...(isAgy ? {
        tiers: agyTiers.map((t) => ({
          id: t.id,
          model: t.model,
          apiKey: t.apiKey,
          cooldownRemainingSec: Math.max(0, Math.round(((tierCooldownUntil.get(t.id) ?? 0) - now) / 1000))
        }))
      } : {})
    });
  }
  if (request.method !== 'POST' || request.url !== '/compose') return send(404, { error: 'Not found.' });
  if (!authorized(request)) return send(401, { error: 'Unauthorized.' });
  if (waiting.length >= 6) return send(429, { error: 'The tour agent is busy with other drafts. Try again in a few minutes.' });
  const chunks = [];
  let size = 0;
  request.on('data', (chunk) => { size += chunk.length; if (size > 48 * 1024 * 1024) request.destroy(); else chunks.push(chunk); });
  request.on('end', async () => {
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { error: 'Invalid request.' }); }
    if (typeof body?.prompt !== 'string' || !body.prompt) return send(400, { error: 'Missing prompt.' });
    const stream = body.stream === true || Boolean(request.headers.accept?.includes('application/x-ndjson'));
    if (stream) {
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      const emit = (payload) => { if (!response.writableEnded) response.write(JSON.stringify(payload) + '\n'); };
      if (running >= concurrent) emit({ type: 'log', text: 'Waiting for an open agent slot…' });
      const heartbeat = setInterval(() => emit({ type: 'ping' }), 5000);
      await slot();
      try {
        const output = await compose(body, (text) => emit({ type: 'log', text }));
        emit({ type: 'done', output });
      } catch (error) {
        emit({ type: 'error', error: error instanceof Error ? error.message : 'The agent failed.' });
      } finally {
        clearInterval(heartbeat);
        release();
        if (!response.writableEnded) response.end();
      }
      return;
    }
    await slot();
    try { send(200, { output: await compose(body) }); }
    catch (error) { send(502, { error: error instanceof Error ? error.message : 'The agent failed.' }); }
    finally { release(); }
  });
}).listen(port, '127.0.0.1', () => console.log(`tour agent service on 127.0.0.1:${port} using ${claude} (${isAgy ? agyTiers.map((t) => `${t.id}:${t.model}`).join(' -> ') : model})`));
