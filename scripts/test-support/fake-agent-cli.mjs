#!/usr/bin/env node
// Stands in for the agent CLI behind scripts/agent/tour-agent-service.mjs (SPHR_TOUR_AGENT_CLAUDE):
// reads one stream-json user message, then answers with a stream-json result. A request that
// says FAIL gets an error result, as when the CLI runs out of quota.
import { readFileSync } from 'node:fs';

const message = JSON.parse(readFileSync(0, 'utf8').trim().split('\n')[0]);
const text = (message.message?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
console.log(JSON.stringify({ type: 'system', subtype: 'init' }));
console.log(JSON.stringify(text.includes('FAIL')
  ? { type: 'result', is_error: true, result: 'The model ran out of quota.' }
  : { type: 'result', result: JSON.stringify({ reply: 'Done.', kind: 'hunt', objects: [], effects: [], stops: [] }) }));
