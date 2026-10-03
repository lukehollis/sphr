#!/usr/bin/env node
// A one-tool MCP server (stdio) that lets the tour agent search the model library while it
// drafts. It only reads: it asks the site's /api/library/search and returns model IDs the
// agent uses as a model's url. No dependencies beyond Node 18.
//
//   SPHR_LIBRARY_SEARCH_URL=http://127.0.0.1:3035/api/library/search node scripts/agent/library-mcp.mjs
const endpoint = process.env.SPHR_LIBRARY_SEARCH_URL ?? '';

const tool = {
  name: 'search_models',
  description: 'Search the whole model library by what you need (for example "bronze statue", "canopic jar", "wooden chest"). Returns model IDs to use as a model\'s url, with names, kinds and heights in meters at scale 1. Several short searches work better than one long one.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] }
};

async function search({ query, limit = 16 }) {
  if (!endpoint) return 'The model library is not available here. Use shapes.';
  const url = new URL(endpoint);
  url.searchParams.set('q', String(query ?? '').slice(0, 200));
  url.searchParams.set('limit', String(Math.max(1, Math.min(40, Number(limit) || 16))));
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) return `The library search failed (HTTP ${response.status}).`;
  const { models = [], total = 0 } = await response.json();
  if (!models.length) return `No models match "${query}" among ${total}. Try other words, or use a shape.`;
  return models.map((model) => `${model.id}: ${model.name} (${model.category}${model.pack ? `, ${model.pack}` : ''}), about ${Math.round(model.height * 100) / 100} m tall${model.tags?.length ? `, ${model.tags.join(' ')}` : ''}`).join('\n');
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
async function handle({ id, method, params }) {
  const reply = (result) => id !== undefined && send({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') return reply({ protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'library', version: '1.0.0' } });
  if (method === 'tools/list') return reply({ tools: [tool] });
  if (method === 'tools/call') {
    if (params?.name !== tool.name) return id !== undefined && send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool ${params?.name}` } });
    try { return reply({ content: [{ type: 'text', text: await search(params.arguments ?? {}) }] }); }
    catch (error) { return reply({ content: [{ type: 'text', text: `The library search failed: ${error.message}` }], isError: true }); }
  }
  if (method === 'ping') return reply({});
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try { void handle(JSON.parse(line)); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  }
});
