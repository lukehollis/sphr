import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';

// Resolve the app's "@/" alias and extensionless TypeScript imports.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@/')) {
      const target = specifier.slice(2), json = target.endsWith('.json');
      if (json) return next(new URL(`../${target}`, import.meta.url).href, { ...context, importAttributes: { type: 'json' } });
      const base = new URL(`../${target}`, import.meta.url);
      for (const candidate of [`${base.href}.ts`, `${base.href}/index.ts`]) if (existsSync(fileURLToPath(candidate))) return next(candidate, context);
    }
    if (specifier.startsWith('.') && context.parentURL?.endsWith('.ts') && !/\.[a-z]+$/.test(specifier)) {
      const base = new URL(specifier, context.parentURL);
      for (const candidate of [`${base.href}.ts`, `${base.href}/index.ts`]) if (existsSync(fileURLToPath(candidate))) return next(candidate, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) { return next(url, url.endsWith('.json') ? { ...context, importAttributes: { type: 'json' } } : context); }
});

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = mkdtempSync(path.join(tmpdir(), 'sphr-tour-agent-'));
Object.assign(process.env, { SPHR_STATE_DIR: directory, SPHR_LIBRARY_FILE: path.join(directory, 'library.json'), SPHR_LIBRARY_URL: '',
  ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', SPHR_TOUR_AGENT_COMMAND: '', SPHR_DISCORD_WEBHOOK_URL: '' });
writeFileSync(process.env.SPHR_LIBRARY_FILE, '[]');
after(() => rmSync(directory, { recursive: true, force: true }));

const THREE = await import('three');
const { parseExperience } = await import('../lib/experience/validate.ts');
const { farFinds, FIND_REACH } = await import('../lib/experience/placement.ts');
const agent = await import('../lib/server/tour-agent.ts');
const { placeOnServer, findProblems } = await import('../lib/server/tour-placement.ts');
const { draftFromRequest, agentErrorForLog, findProblemsNote } = await import('../lib/server/tour-requests.ts');

// What a player may never see: the shapes from the 2026-10-15 audit, and a space's own IDs.
const named = /Location \d+|scan-\d+|pano-\d+/i;
const shape = (id, extra = {}) => ({ id, name: id, source: { kind: 'shape', shape: 'orb' }, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], ...extra });
const labelled = (count) => Array.from({ length: count }, (_, index) => ({
  uuid: `scan-${String(index).padStart(3, '0')}`, label: `Location ${index + 1}`, position: { x: index * 3, y: 1.5, z: 0 } }));
const surface = (geometry) => { const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })); mesh.updateMatrixWorld(true); return mesh; };
const spaceOf = (nodes) => ({ space: { id: 'space', title: 'Space', type: 'spaces', space_data: { nodes: nodes.map((node) => ({ image: 'https://example.com/pano.jpg', ...node })) } } });

test('player-facing text loses location names and keeps what it says', () => {
  const names = agent.internalNamePattern(['scan-013', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4']);
  const scrub = (text) => agent.scrubInternalNames(text, names);
  assert.equal(scrub('Head back up the ramp to the landing at Location 14 and check the edge of the wooden slats.'),
    'Head back up the ramp to the landing and check the edge of the wooden slats.');
  assert.equal(scrub('Walk up into the middle of the long gallery at Location 83, then check the wooden housing on the right wall.'),
    'Walk up into the middle of the long gallery, then check the wooden housing on the right wall.');
  assert.equal(scrub('From scan-013, turn left toward the doorway.'), 'Turn left toward the doorway.');
  assert.equal(scrub('Walk back to pano-4 and look up.'), 'Walk back a few steps and look up.');
  assert.equal(scrub('Location 14 has a carved ledge.'), 'A spot nearby has a carved ledge.');
  assert.equal(scrub('You saw it all, from Location 1 to Location 4.'), 'You saw it all.');
  assert.equal(scrub('The ramp (Location 14) leads down. Look left.'), 'The ramp leads down. Look left.');
  assert.equal(scrub('Check the stairs by a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4.'), 'Check the stairs.', 'the space\'s own long IDs count too');
  assert.equal(scrub('A first line.\n\nThe second, near Locations 3 and 4.'), 'A first line.\n\nThe second.', 'line breaks stay');
  for (const plain of ['The allocation 5 rule is old.', 'It is located 3 meters up.', 'Turn to face 2 tall pillars.', 'Look at the scan of the wall.']) {
    assert.equal(scrub(plain), plain, `untouched: ${plain}`);
  }
});

test('an agent draft that names locations is cleaned, and its stops find their locations', () => {
  const nodes = labelled(4);
  const nodeIds = new Set(nodes.map((node) => node.uuid));
  const aliases = new Map(nodes.map((node) => [node.label.toLowerCase(), node.uuid]));
  const previous = parseExperience({ version: 1, kind: 'hunt', objects: [], effects: [],
    stops: [{ id: 'kept', title: 'Mine', text: 'I wrote Location 9 myself.', view: { nodeId: 'scan-000' }, objects: [], effects: [] }] }, { lenient: true });
  const raw = { reply: 'Here is your hunt.', kind: 'hunt', finale: 'Every relic is back where it belongs at Location 1.',
    objects: [{ ...shape('cup'), place: { nodeId: 'scan-002', x: 0.5, y: 0.6 } }, { ...shape('coin'), label: 'Coin at scan-003', place: { nodeId: 'Location 4', x: 0.5, y: 0.6 } }],
    effects: [],
    stops: [
      { id: 'one', title: 'The gate', text: 'Start by the gate.', nodeId: 'Location 2', look: { nodeId: 'location scan-001', x: 0.5, y: 0.5 },
        objects: ['cup'], effects: [], find: { objectId: 'cup', hint: 'Walk to Location 3 and look on the ledge.', found: 'Found it.' } },
      { id: 'two', title: 'The chamber', text: 'Head into the chamber at scan-003, then look down.', objects: ['coin'], effects: [],
        find: { objectId: 'coin', hint: 'It sits in the corner (Location 4).', found: 'Well done.' } },
      { id: 'kept', title: 'Mine', text: 'I wrote Location 9 myself.', nodeId: 'scan-000', objects: [], effects: [] }] };
  const pattern = agent.internalNamePattern(nodeIds);
  assert.deepEqual(agent.internalNames(structuredClone(raw), previous, pattern), [
    'the finale: Location 1', 'stop 1 hint: Location 3', 'stop 2 text: scan-003', 'stop 2 hint: Location 4', 'the label of coin: scan-003']);

  const { experience, anchors, scrubbed } = agent.normalizeAgentDraft(raw, previous, nodeIds, aliases);
  const [one, two, kept] = experience.stops;
  assert.equal(one.find.hint, 'Walk a few steps and look on the ledge.');
  assert.equal(two.text, 'Head into the chamber, then look down.');
  assert.equal(two.find.hint, 'It sits in the corner.');
  assert.equal(experience.finale, 'Every relic is back where it belongs.');
  assert.equal(experience.objects[1].label, 'Coin');
  assert.equal(scrubbed, 5);
  assert.equal(kept.text, 'I wrote Location 9 myself.', 'text the person wrote is theirs');
  for (const stop of [one, two]) for (const text of [stop.title, stop.text, stop.find?.hint, stop.find?.found]) assert.ok(!named.test(text ?? ''), text);

  assert.equal(one.view.nodeId, 'scan-001', 'a location given by its label is found');
  assert.equal(anchors.stops.one.nodeId, 'scan-001', 'and by its image name');
  assert.equal(anchors.objects.coin.nodeId, 'scan-003');
  assert.equal(two.view.nodeId, 'scan-003', 'a stop without a location stands where its find was picked, not at the first location');
});

test('the agent hears location IDs, never their labels, and is told to keep finds near their clues', async () => {
  const space = { space: { id: 'space', title: 'Space', type: 'spaces', space_data: { nodes: labelled(3) } } };
  const context = await agent.buildAgentContext(space, parseExperience({ version: 1, kind: 'hunt', objects: [], effects: [], stops: [] }), [], 'http://localhost');
  assert.match(context.text, /^scan-001 3 1\.5 0$/m);
  assert.doesNotMatch(context.text, /Location \d/);
  assert.match(agent.SYSTEM, /never write them \(scan-013, Location 14, face 2\)/);
  assert.match(agent.SYSTEM, /within about 8 meters of that clue's own location/);
});

test('a hunt find picked from across the space comes back within reach of its clue', () => {
  const space = spaceOf([{ uuid: 'a', position: { x: 0, y: 1.5, z: 0 } }, { uuid: 'b', position: { x: 0, y: 1.5, z: -30 } }]);
  const floor = surface(new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2));
  const experience = parseExperience({ version: 1, kind: 'hunt', objects: [shape('amulet')], effects: [],
    stops: [{ id: 'three', title: 'Three', text: 'Find the amulet.', view: { nodeId: 'a' }, objects: ['amulet'], effects: [], find: { objectId: 'amulet', hint: 'Look ahead.', found: 'Found.' } }] });
  // Picked in the photo from b, thirty meters on: it lands eight meters past b, 38 from the clue.
  const anchors = { objects: { amulet: { nodeId: 'b', x: 0.75, y: 0.56 } }, effects: {}, stops: {} };
  const unchecked = placeOnServer(space, experience, anchors);
  assert.ok(unchecked.objects[0].position[2] < -37 && unchecked.objects[0].scale[0] > 1, 'without the mesh it stays where the ray met the floor');
  assert.deepEqual(findProblems(space, unchecked).map(({ index, distance }) => [index, distance]), [[0, 38]], 'and is reported');

  const [amulet] = placeOnServer(space, experience, anchors, [floor]).objects;
  const distance = Math.hypot(amulet.position[0], amulet.position[1] - 1.5, amulet.position[2]);
  assert.ok(distance <= FIND_REACH && amulet.position[2] < -5, `it comes toward where it landed, within reach (${amulet.position.map((value) => value.toFixed(2))})`);
  assert.ok(Math.abs(amulet.position[1] - 0.01) < 1e-3, 'on the floor');
  assert.deepEqual(amulet.scale, [1, 1, 1], 'life size again, not grown to read from forty meters');
  assert.deepEqual(findProblems(space, placeOnServer(space, experience, anchors, [floor]), [floor]), []);
});

test('a find whose ray missed the capture near its clue comes back along that ray', () => {
  // The agent stood at b, three meters right of the clue's location, and pointed just under the
  // horizon: the ray skims the floor and meets a wall forty meters away.
  const space = spaceOf([{ uuid: 'a', position: { x: 0, y: 1.5, z: 0 } }, { uuid: 'b', position: { x: 3, y: 1.5, z: 0 } }]);
  const meshes = [surface(new THREE.PlaneGeometry(30, 30).rotateX(-Math.PI / 2)), surface(new THREE.PlaneGeometry(100, 10).translate(0, 5, -40))];
  const experience = parseExperience({ version: 1, kind: 'hunt', objects: [shape('coin')], effects: [],
    stops: [{ id: 'one', title: 'One', text: 'Find the coin.', view: { nodeId: 'a' }, objects: ['coin'], effects: [], find: { objectId: 'coin', hint: 'Ahead.', found: 'Found.' } }] });
  const [coin] = placeOnServer(space, experience, { objects: { coin: { nodeId: 'b', x: 0.75, y: 0.505 } }, effects: {}, stops: {} }, meshes).objects;
  assert.ok(Math.abs(coin.position[0] - 3) < 0.2 && coin.position[2] < -4, `on the ground under the agent's own ray (${coin.position.map((value) => value.toFixed(2))})`);
  assert.ok(Math.hypot(coin.position[0], coin.position[1] - 1.5, coin.position[2]) <= FIND_REACH);
});

test('clues a player may never get past are found and named for the owner', () => {
  const space = spaceOf([{ uuid: 'a', position: { x: 0, y: 1.5, z: 0 } }]);
  const experience = parseExperience({ version: 1, kind: 'hunt', effects: [],
    objects: [shape('near', { position: [0, 0, -4] }), shape('far', { position: [0, 0, -21] }), shape('walled', { position: [0, 0, 5] })],
    stops: ['near', 'far', 'walled'].map((id) => ({ id, title: id, text: 'Find it.', view: { nodeId: 'a' }, objects: [id], effects: [], find: { objectId: id, hint: 'Look.', found: 'Found.' } })) });
  assert.deepEqual(farFinds(experience, (nodeId) => nodeId === 'a' ? [0, 1.5, 0] : null), [{ index: 1, stopId: 'far', objectId: 'far', distance: 21 }]);
  assert.deepEqual(farFinds({ ...experience, kind: 'tour' }, () => [0, 1.5, 0]), [], 'a guided tour has nothing to find');
  // A wall between the clue's location and the third find, and no other location to see it from.
  const meshes = [surface(new THREE.PlaneGeometry(50, 50).rotateX(-Math.PI / 2)), surface(new THREE.PlaneGeometry(10, 4).translate(0, 2, 2.5))];
  const problems = findProblems(space, experience, meshes);
  assert.deepEqual(problems.map(({ index, distance, hidden }) => [index, distance, Boolean(hidden)]), [[1, 21, false], [2, 5, true]]);
  assert.equal(findProblemsNote(problems.slice(0, 1)), 'Clue 2\'s object is 21 meters from where the clue starts, so players may not find it. Check it in the builder.');
  assert.equal(findProblemsNote(problems.slice(1)), 'Clue 3\'s object can\'t be seen from where the clue starts, so players may not find it. Check it in the builder.');
  assert.match(findProblemsNote(problems), /^The objects for clues 2 and 3 are far/);
});

test('a failed draft is logged with its space and tour, never the request', async () => {
  const bootstrap = { space: { id: 'space', title: 'Space', type: 'spaces', space_data: { nodes: labelled(2) } } };
  const requests = [];
  const server = createServer((request, response) => {
    if (request.url === '/bootstrap.json') { response.writeHead(200, { 'Content-Type': 'application/json' }); return response.end(JSON.stringify(bootstrap)); }
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({ url: request.url, body: JSON.parse(body) });
      response.writeHead(502, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'The agent did not return a JSON draft: Here is a hunt for Emma\'s seventh birthday' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  Object.assign(process.env, { SPHR_TOUR_AGENT_URL: origin, SPHR_TOUR_AGENT_TOKEN: 'test-token' });
  const scene = { sceneId: 'testscene', title: 'Test space', bootstrapUrl: `${origin}/bootstrap.json` };
  const lines = [];
  const warn = console.warn;
  console.warn = (...parts) => lines.push(parts.join(' '));
  try {
    await assert.rejects(draftFromRequest(scene, { prompt: 'A birthday hunt for Emma, who loves cats', kind: 'hunt' }, origin, false, { tourId: 'tour12345678' }),
      (error) => error instanceof agent.TourAgentError && /Emma/.test(error.message), 'the person still reads what went wrong');
    await assert.rejects(draftFromRequest(scene, { prompt: 'x'.repeat(6001) }, origin, false, { tourId: 'tour12345678' }));
  } finally {
    console.warn = warn;
    server.close();
    Object.assign(process.env, { SPHR_TOUR_AGENT_URL: '', SPHR_TOUR_AGENT_TOKEN: '' });
  }
  assert.deepEqual(requests.map((item) => [item.url, item.body.meta]), [['/compose', { scene: 'testscene', tour: 'tour12345678' }]], 'the service hears the IDs for its own log');
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[0], /^\[tour-agent\] failed after \d+s scene=testscene tour=tour12345678 kind=hunt: The agent did not return a JSON draft: \(\d+ characters of its answer left out\)$/);
  assert.equal(lines[1], '[tour-agent] refused scene=testscene tour=tour12345678 kind=tour: the request was 6001 characters');
  assert.ok(!lines.some((line) => /Emma|cats/.test(line)), 'nothing anyone wrote');
  assert.equal(agentErrorForLog('The agent took too long.'), 'The agent took too long.');
});

test('the agent service logs each draft with its IDs, never what was asked or answered', async () => {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const token = 'x'.repeat(40);
  const child = spawn(process.execPath, [path.join(root, 'scripts/agent/tour-agent-service.mjs')], {
    env: { ...process.env, SPHR_TOUR_AGENT_SERVICE_TOKEN: token, SPHR_TOUR_AGENT_SERVICE_PORT: String(port),
      SPHR_TOUR_AGENT_CLAUDE: path.join(root, 'scripts/test-support/fake-agent-cli.mjs'), SPHR_LIBRARY_SEARCH_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    for (let tries = 0; !output.includes('tour agent service on') && tries < 100; tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    const compose = (prompt, stream) => fetch(`http://127.0.0.1:${port}/compose`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(stream ? { Accept: 'application/x-ndjson' } : {}) },
      body: JSON.stringify({ system: 'Build tours.', prompt, images: [{ label: 'location a face 1', data: 'AAAA' }], meta: { scene: '619ad80511a1', tour: 'cec7834385db' }, ...(stream ? { stream: true } : {}) }) });
    const done = await compose('A hunt for Emma', false);
    assert.equal(done.status, 200);
    const failed = await compose('FAIL a hunt for Emma', true);
    assert.match(await failed.text(), /"type":"error","error":"The model ran out of quota\."/);
    const refused = await fetch(`http://127.0.0.1:${port}/compose`, { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: '{}' });
    assert.equal(refused.status, 401);
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally { child.kill(); }
  assert.match(output, /\[tour-agent\] #1 scene=619ad80511a1 tour=cec7834385db started: 1 images, 15 characters/);
  assert.match(output, /\[tour-agent\] #1 scene=619ad80511a1 tour=cec7834385db done in \d+s, \d+ characters/);
  assert.match(output, /\[tour-agent\] #2 scene=619ad80511a1 tour=cec7834385db failed after \d+s: The model ran out of quota\./);
  assert.match(output, /refused a request without the right token/);
  assert.doesNotMatch(output, /Emma|Build tours|"stops"/, 'requests and answers stay out of the log');
});
