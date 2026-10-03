// Stands in for the tour agent CLI in tests (SPHR_TOUR_AGENT_COMMAND): keeps the prompt it was
// given in FAKE_TOUR_AGENT_LOG, so tests can check what the agent is told, and answers with a
// draft that points at pixels of the first location for the server to place.
import { appendFileSync, readFileSync } from 'node:fs';

const prompt = readFileSync(0, 'utf8');
if (process.env.FAKE_TOUR_AGENT_LOG) appendFileSync(process.env.FAKE_TOUR_AGENT_LOG, `${JSON.stringify({ prompt })}\n`);
const location = prompt.match(/^Locations \(id[^\n]*\n(\S+)/m)?.[1];
if (!location) { console.error('No locations in the prompt.'); process.exit(1); }
// The first library model the prompt lists, by its code, if any.
const libraryCode = prompt.match(/^(lib\d+) /m)?.[1];
const kind = /Make this a scavenger hunt/.test(prompt) ? 'hunt' : 'tour';
const place = { nodeId: location, x: 0.25, y: 0.62 };
console.log(`Here is the draft:\n${JSON.stringify({
  reply: 'I placed the tripod on the altar platform and opened with a line drawing that sweeps into color.',
  kind,
  finale: 'You have seen the altar.',
  style: { look: 'lines', transition: 'fade', duration: 1 },
  objects: [{ id: 'tripod', name: 'Bronze tripod', source: libraryCode ? { kind: 'model', url: libraryCode } : { kind: 'shape', shape: 'orb', color: '#c08a3e' }, place }],
  effects: [{ id: 'glow', type: 'beacon', target: { kind: 'point', place }, params: {} }],
  stops: [{ id: 'altar', title: 'The altar', text: 'Pilgrims left offerings here.', nodeId: location, look: place,
    style: { look: 'color', transition: 'sweep', duration: 2 }, objects: ['tripod'], effects: ['glow'],
    ...(kind === 'hunt' ? { find: { objectId: 'tripod', hint: 'Look at the platform.', found: 'Tripods held offerings.' } } : {}) }]
})}`);
