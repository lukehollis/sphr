import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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

const { parseExperience, ExperienceError } = await import('../lib/experience/validate.ts');
const { applyExperience, experienceFromBootstrap } = await import('../lib/experience/apply.ts');
const { applySceneEdits } = await import('../lib/scene-edits.ts');
const { normalizeTour } = await import('../lib/bootstrap.ts');
const { tourSegment } = await import('../lib/viewer/segments.ts');
const { normalizeAgentDraft, extractJson, pickLibrary, resolveLibraryCodes } = await import('../lib/server/tour-agent.ts');
const { panoramaPixelDirection } = await import('../lib/three/renderers/PanoramaLayer.ts');
const store = await import('../lib/server/admin-store.ts');
const { readSceneTour } = await import('../lib/server/tours.ts');

const directory = mkdtempSync(path.join(tmpdir(), 'sphr-experience-'));
process.env.SPHR_STATE_DIR = directory;
after(() => rmSync(directory, { recursive: true, force: true }));

const view = { nodeId: 'a', rotation: { azimuth: 10, polar: -5 }, fov: 70 };
const tour = () => ({
  version: 1, kind: 'tour', finale: 'Thank you.',
  objects: [{ id: 'orb', name: 'Orb', source: { kind: 'shape', shape: 'orb', color: '#FF0000' }, position: [1, 2, 3], rotation: [0, 90, 0], scale: 2 }],
  effects: [
    { id: 'scan', type: 'scan', target: { kind: 'scene' }, params: { speed: 900, color: 'red', mode: 'pulse' } },
    { id: 'glow', type: 'sparkles', target: { kind: 'object', id: 'orb' }, params: {}, always: true }
  ],
  stops: [{ id: 'one', title: 'First', text: 'Hello\r\n\r\nWorld', view, objects: ['orb', 'missing'], effects: ['scan'] }]
});
const bootstrap = () => ({
  space: { id: 'space', title: 'Space', type: 'spaces', space_data: { nodes: [
    { uuid: 'a', position: { x: 0, y: 1.5, z: 0 }, image: 'https://example.com/a.jpg' },
    { uuid: 'b', position: { x: 4, y: 1.5, z: 0 }, faces: ['https://example.com/0.jpg', '1', '2', '3', '4', '5'] }
  ] } },
  tour: { title: 'Old tour', tour_data: { spaces: [{ id: 'space', tourpoints: [
    { id: 'p1', nodeUUID: 'a', text: '<p>Old <b>bold</b> text</p><p>Second &amp; last</p>', rotation: { azimuth: 1, polar: 2 }, files: [{ url: 'https://example.com/i.jpg' }], sounds: ['narration'] }
  ] }, { id: 'other', tourpoints: [{ id: 'p2', nodeUUID: 'z', text: 'Elsewhere' }] }] } },
  orderedSpaces: [
    { id: 'space', title: 'Space', type: 'spaces', space_data: { nodes: [{ uuid: 'a', position: { x: 0, y: 0, z: 0 } }] } },
    { id: 'other', title: 'Other', type: 'spaces', space_data: { nodes: [{ uuid: 'z', position: { x: 0, y: 0, z: 0 } }] } }
  ]
});

test('validates and normalizes a tour', () => {
  const result = parseExperience(tour(), { nodeIds: new Set(['a', 'b']) });
  assert.equal(result.kind, 'tour');
  assert.deepEqual(result.objects[0].scale, [2, 2, 2]);
  assert.equal(result.objects[0].source.color, '#ff0000');
  assert.equal(result.effects[0].params.speed, 40, 'numbers clamp to their range');
  assert.equal(result.effects[0].params.color, '#7fd6ff', 'invalid colors fall back to the default');
  assert.equal(result.effects[0].params.mode, 'pulse');
  assert.equal(result.effects[1].params.mode, 'aura', 'missing params take defaults');
  assert.deepEqual(result.stops[0].objects, ['orb'], 'unknown objects are dropped from stops');
  assert.equal(result.stops[0].text, 'Hello\n\nWorld');
});

test('rejects what a viewer must never load', () => {
  const bad = (patch, message) => assert.throws(() => parseExperience({ ...tour(), ...patch }, { nodeIds: new Set(['a']) }), ExperienceError, message);
  bad({ objects: [{ id: 'm', name: 'M', source: { kind: 'model', url: 'javascript:alert(1)' }, position: [0, 0, 0] }] }, 'script URLs');
  bad({ objects: [{ id: 'm', name: 'M', source: { kind: 'model', url: 'http://example.com/a.glb' }, position: [0, 0, 0] }] }, 'plain http');
  bad({ effects: [{ id: 'x', type: 'not-installed', target: { kind: 'scene' } }] }, 'unknown effects');
  bad({ effects: [{ id: 'x', type: 'beacon', target: { kind: 'scene' } }] }, 'targets an effect cannot use');
  bad({ stops: [{ id: 'one', title: '', text: '', view: { nodeId: 'gone', rotation: { azimuth: 0, polar: 0 } } }] }, 'removed locations');
  bad({ objects: [tour().objects[0], tour().objects[0]] }, 'duplicate IDs');
  bad({ kind: 'hunt' }, 'hunt steps without something to find');
  const lenient = parseExperience({ ...tour(), effects: [{ id: 'x', type: 'not-installed', target: { kind: 'scene' } }] }, { lenient: true });
  assert.equal(lenient.effects.length, 0, 'lenient parsing drops effects a deployment no longer has');
});

test('hunts need an object at every step', () => {
  const hunt = { ...tour(), kind: 'hunt', stops: [{ ...tour().stops[0], find: { objectId: 'orb', hint: 'Look up', found: 'Found it' } }] };
  const result = parseExperience(hunt);
  assert.deepEqual(result.stops[0].find, { objectId: 'orb', hint: 'Look up', found: 'Found it' });
});

test('applies an experience to the opening space only', () => {
  const experience = parseExperience(tour());
  const applied = applyExperience(bootstrap(), experience);
  const data = applied.tour.tour_data;
  assert.equal(data.mode, 'guided');
  assert.equal(data.spaces.length, 2, 'later spaces stay');
  assert.equal(data.spaces[0].tourpoints[0].format, 'plain');
  assert.deepEqual(data.spaces[0].tourpoints[0].effects, ['scan']);
  const normalized = normalizeTour(applied);
  assert.equal(normalized.objects.length, 1);
  assert.equal(normalized.effects.length, 2);
  assert.equal(tourSegment(applied, 0, 0).bootstrap.tour.tour_data.objects.length, 1);
  assert.equal(tourSegment(applied, 1, 0).bootstrap.tour.tour_data.objects.length, 0, 'objects never leak into another space');
  const edited = applySceneEdits(bootstrap(), { title: 'New', startView: null, experience });
  assert.equal(edited.tour.tour_data.kind, 'tour');
  assert.equal(edited.space.title, 'New');
});

test('older authored stops become editable plain text with their media', () => {
  const experience = experienceFromBootstrap(bootstrap());
  assert.equal(experience.stops.length, 1);
  assert.equal(experience.stops[0].text, 'Old bold text\n\nSecond & last');
  assert.equal(experience.stops[0].view.nodeId, 'a');
  assert.deepEqual(experience.stops[0].sounds, ['narration']);
  assert.equal(experience.stops[0].files[0].url, 'https://example.com/i.jpg');
});

test('splits agent placements from its draft', () => {
  const previous = parseExperience(tour());
  const raw = {
    reply: 'Made it.', kind: 'hunt', finale: 'All found.',
    objects: [
      { id: 'orb', name: 'Orb', source: { kind: 'shape', shape: 'orb' }, place: null, position: null },
      { id: 'star', name: 'Star', source: { kind: 'shape', shape: 'marker' }, place: { nodeId: 'b', face: 2, x: 0.4, y: 1.7 } }
    ],
    effects: [{ id: 'spot', type: 'beacon', target: { kind: 'point', place: { nodeId: 'a', x: 0.5, y: 0.5 } }, params: { height: 2 } }],
    stops: [
      { id: 'one', title: 'Find the star', text: 'Look up high.', nodeId: 'b', look: { face: 2, x: 0.5, y: 0.4 }, find: { objectId: 'star', hint: 'Near the dome' } },
      { id: 'two', title: 'Elsewhere', text: 'Bad location', nodeId: 'nowhere', find: { objectId: 'orb' } }
    ]
  };
  const result = normalizeAgentDraft(raw, previous, new Set(['a', 'b']));
  assert.equal(result.reply, 'Made it.');
  assert.deepEqual(result.experience.objects.find((object) => object.id === 'orb').position, [1, 2, 3], 'unplaced objects keep their position');
  assert.deepEqual(result.anchors.objects.star, { nodeId: 'b', face: 2, x: 0.4, y: 1 });
  assert.deepEqual(result.anchors.stops.one, { nodeId: 'b', face: 2, x: 0.5, y: 0.4 });
  assert.equal(result.experience.stops[1].view.nodeId, 'a', 'stops on unknown locations fall back to a real one');
  assert.ok(result.anchors.effects.spot);
  assert.equal(result.experience.kind, 'hunt');
});

test('reads drafts from agent command output', () => {
  const draft = { reply: 'ok', kind: 'tour', objects: [], effects: [], stops: [] };
  assert.deepEqual(extractJson(JSON.stringify({ type: 'result', result: 'Here you go:\n```json\n' + JSON.stringify(draft) + '\n```' })), draft);
  assert.deepEqual(extractJson('Sure! ' + JSON.stringify(draft)), draft);
  assert.throws(() => extractJson('no json here'));
});

test('panorama pixels map to the directions the viewer renders', () => {
  const equirect = { uuid: 'e', position: { x: 0, y: 0, z: 0 }, image: 'x.jpg' };
  const top = panoramaPixelDirection(equirect, 0.3, 0);
  assert.ok(top.y > 0.999, 'the top row looks straight up');
  const horizon = panoramaPixelDirection(equirect, 0.25, 0.5);
  assert.ok(Math.abs(horizon.y) < 1e-6 && Math.abs(horizon.length() - 1) < 1e-6);
  const cube = { uuid: 'c', position: { x: 0, y: 0, z: 0 }, faces: ['0', '1', '2', '3', '4', '5'], quaternion: [0, 0, 0, 1] };
  const center = panoramaPixelDirection(cube, 0.5, 0.5, 3);
  assert.ok(Math.abs(center.z + 1) < 1e-6, 'face 3 centers on -z');
  const up = panoramaPixelDirection(cube, 0.5, 0.0, 3);
  assert.ok(up.y > 0, 'the top of a side face is above the horizon');
});

test('stores tours with revision checks', () => {
  const experience = parseExperience(tour());
  assert.deepEqual(readSceneTour('abcdefabcdef'), { experience: null, revision: 0 });
  store.saveSceneTour('abcdefabcdef', 0, experience);
  assert.equal(readSceneTour('abcdefabcdef').experience.stops[0].title, 'First');
  assert.throws(() => store.saveSceneTour('abcdefabcdef', 0, experience), store.EditConflict);
  store.saveSceneTour('abcdefabcdef', 1, null);
  assert.deepEqual(readSceneTour('abcdefabcdef'), { experience: null, revision: 2 });
});

test('the agent sees the library models that match the request, under codes it can place', () => {
  const library = [
    ...Array.from({ length: 30 }, (_, index) => ({ id: `chair-${index}`, name: `Chair ${index}`, category: 'Furniture', url: `https://cdn.example/chair-${index}.glb`, height: 1 })),
    { id: 'sphinx', name: 'Sphinx', category: 'Ancient Egypt', url: 'https://cdn.example/sphinx.glb', height: 3, tags: ['egypt'] },
    { id: 'pyramid', name: 'Pyramid', category: 'Ancient Egypt', url: 'https://cdn.example/pyramid.glb', height: 4, tags: ['egypt'] },
    { id: 'coin', name: 'Gold coin', category: 'Collectibles', url: 'https://cdn.example/coin.glb', height: 0.06 }
  ];
  const draft = parseExperience({ version: 1, kind: 'hunt', stops: [], effects: [], objects: [
    { id: 'seat', name: 'Seat', source: { kind: 'model', url: 'https://cdn.example/chair-29.glb' }, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }] });
  const picked = pickLibrary(library, 'A hunt for Egyptian treasures and gold coins', draft, 180, 2);
  const urls = picked.listed.map((model) => model.url);
  assert.ok(urls.includes('https://cdn.example/sphinx.glb') && urls.includes('https://cdn.example/coin.glb'));
  assert.ok(urls.includes('https://cdn.example/chair-29.glb'), 'models already placed stay listed');
  assert.equal(urls.filter((url) => url.includes('chair')).length, 3, 'other categories show only a few');
  const code = [...picked.codes].find(([, url]) => url.endsWith('sphinx.glb'))[0];
  const raw = resolveLibraryCodes({ objects: [{ id: 'a', source: { kind: 'model', url: code } }, { id: 'b', source: { kind: 'model', url: 'https://other.example/x.glb' } }] }, picked.codes);
  assert.equal(raw.objects[0].source.url, 'https://cdn.example/sphinx.glb');
  assert.equal(raw.objects[1].source.url, 'https://other.example/x.glb');
});

test('looks are validated for the tour and each stop, and reach the viewer', () => {
  const input = tour();
  input.look = { look: 'blueprint', params: { grid: 9, line: '#ABCDEF' }, transition: 'sweep', duration: 30 };
  input.stops[0].look = { look: 'lines', transition: 'iris' };
  input.stops.push({ id: 'two', title: 'Two', text: 'Back to color', view, objects: [], effects: [], look: 'color' });
  const parsed = parseExperience(input);
  assert.deepEqual(parsed.look, { look: 'blueprint', params: { paper: '#123f78', line: '#abcdef', grid: 1, fill: 0.16 }, transition: 'sweep', duration: 8 }, 'params are clamped and filled in');
  assert.deepEqual(parsed.stops[0].look, { look: 'lines', params: { paper: '#f4f1e8', ink: '#1d1c1a', weight: 1.3, hatching: 0.55, color: 0 }, transition: 'iris' });
  assert.deepEqual(parsed.stops[1].look, { look: 'color' }, 'a stop can return to the capture itself');
  assert.throws(() => parseExperience({ ...tour(), look: { look: 'nonsense' } }), ExperienceError);
  const lenient = parseExperience({ ...tour(), look: { look: 'nonsense' }, stops: [{ ...tour().stops[0], look: { look: 'lines', transition: 'spin' } }] }, { lenient: true });
  assert.equal(lenient.look, undefined, 'unknown looks are dropped from agent drafts');
  assert.equal(lenient.stops[0].look.transition, undefined, 'unknown transitions are dropped');
  const applied = applyExperience(bootstrap(), parsed);
  assert.equal(applied.tour.tour_data.look.look, 'blueprint');
  assert.equal(applied.tour.tour_data.spaces[0].tourpoints[0].look.look, 'lines');
  assert.equal(normalizeTour(applied).look.look, 'blueprint');
  assert.equal(experienceFromBootstrap(applied).stops[1].look.look, 'color', 'looks survive a round trip through the bootstrap');
  const agent = normalizeAgentDraft({ reply: 'ok', kind: 'tour', style: { look: 'noir', transition: 'fade' },
    objects: [], effects: [], stops: [{ id: 'one', title: 'One', text: 'Hi', nodeId: 'a', style: { look: 'watercolor' } }, { id: 'two', title: 'Two', text: 'Hi', nodeId: 'a' }] }, parsed, new Set(['a', 'b']));
  assert.equal(agent.experience.look.look, 'noir');
  assert.equal(agent.experience.stops[0].look.look, 'watercolor');
  assert.equal(agent.experience.stops[1].look.look, 'color', 'a stop the agent leaves alone keeps its look');
});

test('an agent draft keeps going when a model it names is not in the library', () => {
  const result = normalizeAgentDraft({ reply: 'Placed a temple.', kind: 'tour', objects: [
    { id: 'temple', name: 'Temple', source: { kind: 'model' } },
    { id: 'orb', name: 'Orb', source: { kind: 'shape', shape: 'orb' } }
  ], effects: [], stops: [{ id: 'one', title: 'One', text: 'Hi', nodeId: 'a', objects: ['temple', 'orb'] }] }, parseExperience(tour()), new Set(['a']));
  assert.deepEqual(result.experience.objects.map((object) => object.id), ['orb']);
  assert.deepEqual(result.experience.stops[0].objects, ['orb']);
  assert.match(result.reply, /One object could not be placed/);
  assert.throws(() => parseExperience({ ...tour(), objects: [{ id: 'x', name: 'X', source: { kind: 'model' }, position: [0, 0, 0] }] }), ExperienceError, 'saved tours are still strict');
});

test('agents search the whole library and name models by ID', async () => {
  const { searchLibrary, describeModel } = await import('../lib/experience/library-search.ts');
  const library = [
    { id: 'amphora-red', name: 'Red-figure amphora', category: 'Ancient Greece', pack: 'Greek pottery', url: 'https://cdn.example/amphora.glb', height: 0.9, tags: ['vase'] },
    { id: 'athena', name: 'Statue of Athena', category: 'Ancient Greece', url: 'https://cdn.example/athena.glb', height: 2.4, tags: ['statue', 'goddess'] },
    { id: 'lamp', name: 'Oil lamp', category: 'Ancient Rome', url: 'https://cdn.example/lamp.glb', height: 0.1, tags: ['light'] },
    { id: 'statue-horse', name: 'Horse statue', category: 'Ancient Rome', url: 'https://cdn.example/horse.glb', height: 2, tags: ['animal'] },
    { id: 'cat', name: 'Temple cat', category: 'Animals', url: 'https://cdn.example/cat.glb', height: 0.3, animations: ['idle', 'walk', 7] }
  ];
  assert.deepEqual(searchLibrary(library, 'statues').map((model) => model.id), ['athena', 'statue-horse'], 'plurals match and names rank first');
  assert.deepEqual(searchLibrary(library, 'roman horse statue').map((model) => model.id).slice(0, 1), ['statue-horse'], 'models matching every word lead');
  assert.deepEqual(searchLibrary(library, 'lamp').map((model) => model.id), ['lamp'], 'an exact ID comes first');
  assert.deepEqual(searchLibrary(library, 'the and please'), [], 'words without meaning find nothing');
  assert.equal(searchLibrary(library, 'ancient', 2).length, 2);
  assert.equal(describeModel(library[0]), 'amphora-red: Red-figure amphora (Ancient Greece, Greek pottery), about 0.9 m tall at scale 1, vase');
  assert.equal(describeModel(library[4]), 'cat: Temple cat (Animals), about 0.3 m tall at scale 1, animated: idle, walk', 'agents see which models move');
  const raw = resolveLibraryCodes({ objects: [{ id: 'a', source: { kind: 'model', url: 'athena' } }, { id: 'b', source: { kind: 'model', url: 'library:lamp' } },
    { id: 'c', source: { kind: 'model', url: 'not-a-model' } }] }, new Map(), library);
  assert.deepEqual(raw.objects.map((object) => object.source.url), ['https://cdn.example/athena.glb', 'https://cdn.example/lamp.glb', 'not-a-model']);
});

test('agent drafts are placed on the server like the builder places them', async () => {
  const THREE = await import('three');
  const { placeOnServer } = await import('../lib/server/tour-placement.ts');
  const experience = parseExperience({ version: 1, kind: 'tour', objects: [
    { id: 'near', name: 'Near', source: { kind: 'shape', shape: 'orb' }, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    { id: 'sky', name: 'Sky', source: { kind: 'shape', shape: 'orb' }, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    { id: 'far', name: 'Far', source: { kind: 'shape', shape: 'orb' }, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    { id: 'feet', name: 'Feet', source: { kind: 'shape', shape: 'orb' }, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }
  ], effects: [{ id: 'glow', type: 'beacon', target: { kind: 'point', position: [0, 0, 0] }, params: {} }],
  stops: [{ id: 'one', title: 'One', text: 'Hi', view: { nodeId: 'b' }, objects: ['near'], effects: ['glow'] }] });
  const space = { space: { id: 'space', title: 'Space', type: 'spaces', space_data: { nodes: [
    { uuid: 'a', position: { x: 0, y: 1.5, z: 0 }, floorPosition: { x: 0, y: 0, z: 0 }, image: 'https://example.com/a.jpg' },
    { uuid: 'b', position: { x: 4, y: 1.5, z: 0 }, image: 'https://example.com/b.jpg' }] } } };
  const below = { nodeId: 'a', x: 0.25, y: 0.6 };
  const anchors = { objects: { near: below, sky: { nodeId: 'a', x: 0.25, y: 0.2 }, far: { nodeId: 'a', x: 0.25, y: 0.5175 }, feet: { nodeId: 'a', x: 0.25, y: 0.97 } },
    effects: { glow: below }, stops: { one: below } };
  const reach = (position) => Math.hypot(position[0], position[2]);

  // Without a capture mesh, the floor under the location is the ground.
  let placed = placeOnServer(space, experience, anchors);
  let [near, sky, far, feet] = placed.objects;
  const out = 1.5 / Math.tan(Math.PI * 0.1);
  assert.ok(Math.abs(near.position[1]) < 1e-6 && Math.abs(reach(near.position) - out) < 0.01, 'on the floor where the ray lands');
  assert.deepEqual(near.scale, [1, 1, 1], 'close things keep their size');
  assert.ok(Math.abs(reach(sky.position) - 4) < 1e-6 && Math.abs(sky.position[1]) < 1e-6, 'pointing up stands it four meters out on the floor');
  assert.ok(Math.abs(reach(far.position) - 4) < 1e-6, 'beyond 25 meters of flat floor counts as open air');
  assert.ok(Math.abs(reach(feet.position) - 2) < 1e-6, 'never at the visitor\'s feet');
  assert.equal(near.rotation[1], sky.rotation[1], 'turned along the ray');
  assert.deepEqual(placed.effects[0].target.position, near.position, 'point effects sit where the ray lands');
  const aim = placed.stops[0].view.rotation;
  const toward = Math.atan2(-(near.position[0] - 4), -near.position[2]) * 180 / Math.PI;
  assert.ok(Math.abs(aim.azimuth - toward) < 0.1 && aim.polar < 0, 'a stop elsewhere looks toward the same spot');

  // With one, rays meet the captured surfaces: a slope rising away from the location, and a wall.
  const slope = new THREE.Mesh(new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2).rotateX(-0.2), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  slope.updateMatrixWorld(true);
  placed = placeOnServer(space, experience, anchors, [slope]);
  [near, sky, far] = placed.objects;
  const ground = (position) => position[2] * Math.tan(0.2);
  assert.ok(Math.abs(near.position[1] - 0.01 - ground(near.position)) < 0.02 && reach(near.position) < out, 'it rests on the rising ground, nearer than the flat floor would put it');
  assert.ok(reach(far.position) > 4 && far.scale[0] > 1, 'far ground is reached, and what lands there grows to be seen');
  assert.ok(Math.abs(reach(sky.position) - 4) < 1e-6, 'sky still stands four meters out');
  const { placeObjectAt } = await import('../lib/experience/placement.ts');
  const spot = { position: [0, 0, -40], normal: [0, 1, 0], hit: true, distance: 40, origin: [0, 1.5, 0], floor: 0, rotation: { azimuth: 0, polar: -2 } };
  const statue = { id: 'statue', name: 'Statue', source: { kind: 'model', url: 'https://cdn.example/statue.glb' }, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
  assert.deepEqual(placeObjectAt(statue, spot).scale, [2, 2, 2], 'life-size models grow at most twice');
  assert.deepEqual(placeObjectAt({ ...statue, source: { kind: 'shape', shape: 'marker' } }, spot).scale, [5, 5, 5], 'markers grow up to five times');
});

test('a hunt object hidden from its clue comes forward where the visitor can see it', async () => {
  const THREE = await import('three');
  const { placeOnServer } = await import('../lib/server/tour-placement.ts');
  const shape = (id) => ({ id, name: id, source: { kind: 'shape', shape: 'orb' }, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
  const experience = parseExperience({ version: 1, kind: 'hunt', objects: [shape('coin'), shape('cup'), shape('far')], effects: [], stops: [
    { id: 'one', title: 'One', text: 'Find the coin.', view: { nodeId: 'a' }, objects: ['coin'], effects: [], find: { objectId: 'coin', hint: 'Up the step.', found: 'Found.' } },
    { id: 'two', title: 'Two', text: 'Find the cup.', view: { nodeId: 'a' }, objects: ['cup', 'far'], effects: [], find: { objectId: 'cup', hint: 'Behind you.', found: 'Found.' } }] });
  const space = { space: { id: 'space', title: 'Space', type: 'spaces', space_data: { nodes: [
    { uuid: 'a', position: { x: 0, y: 1.5, z: 0 }, image: 'https://example.com/a.jpg' }, { uuid: 'b', position: { x: 0, y: 3.5, z: 7 }, image: 'https://example.com/b.jpg' }] } } };
  // Open floor, and a two-meter step between the clue's location and the far side.
  const surface = (geometry) => { const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })); mesh.updateMatrixWorld(true); return mesh; };
  const meshes = [surface(new THREE.PlaneGeometry(100, 100).rotateX(-Math.PI / 2)), surface(new THREE.PlaneGeometry(10, 2).translate(0, 1, 3)),
    surface(new THREE.PlaneGeometry(10, 3).rotateX(-Math.PI / 2).translate(0, 2, 4.5))];
  // The coin was picked in the photo from the top of the step; the cup in plain view behind the clue's location.
  const placed = placeOnServer(space, experience, { objects: { coin: { nodeId: 'b', x: 0.75, y: 0.75 }, cup: { nodeId: 'a', x: 0.75, y: 0.6 }, far: { nodeId: 'a', x: 0.75, y: 0.5175 } }, effects: {}, stops: {} }, meshes);
  const [coin, cup, far] = placed.objects;
  assert.ok(Math.abs(coin.position[1] - 0.01) < 1e-3 && coin.position[2] > 2 && coin.position[2] < 3, `it comes down in front of the step (${coin.position.map((value) => value.toFixed(2))})`);
  assert.ok(Math.abs(cup.position[1]) < 0.02 && cup.position[2] < -4, 'what the visitor can already see stays where it was put');
  assert.ok(Math.abs(Math.hypot(far.position[0], far.position[2]) - 18) < 0.5 && Math.abs(far.position[1] - 0.01) < 1e-3, `far across the space it comes to 18 meters along the same line (${far.position.map((value) => value.toFixed(1))})`);
});

test('in a guided tour, objects come into the view of the stop that shows them', async () => {
  const THREE = await import('three');
  const { placeOnServer } = await import('../lib/server/tour-placement.ts');
  const shape = (id) => ({ id, name: id, source: { kind: 'shape', shape: 'orb' }, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
  const stops = [{ id: 'one', title: 'One', text: 'Look ahead.', view: { nodeId: 'a', rotation: { azimuth: 0, polar: -10 } }, objects: ['behind', 'ahead', 'aside'], effects: [] }];
  const space = { space: { id: 'space', title: 'Space', type: 'spaces', space_data: { nodes: [{ uuid: 'a', position: { x: 0, y: 1.5, z: 0 }, image: 'https://example.com/a.jpg' }] } } };
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(100, 100).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  floor.updateMatrixWorld(true);
  // x = 0.875 is 45 degrees to the left of straight ahead (x = 0.75), under the tour's text on a wide screen.
  const anchors = { objects: { behind: { nodeId: 'a', x: 0.25, y: 0.6 }, ahead: { nodeId: 'a', x: 0.75, y: 0.6 }, aside: { nodeId: 'a', x: 0.875, y: 0.6 } }, effects: {}, stops: {} };
  const tour = placeOnServer(space, parseExperience({ version: 1, kind: 'tour', objects: [shape('behind'), shape('ahead'), shape('aside')], effects: [], stops }), anchors, [floor]);
  const [behind, ahead, aside] = tour.objects;
  const sideways = (position) => Math.atan2(position[0], -position[2]) * 180 / Math.PI;
  assert.ok(Math.abs(sideways(aside.position)) < 30 && aside.position[2] < -3, `what was at the edge of the view comes toward its middle (${sideways(aside.position).toFixed(0)} degrees)`);
  assert.ok(sideways(behind.position) > 0, 'a little right of center, clear of the text');
  assert.ok(behind.position[2] < -2.5 && Math.abs(behind.position[1] - 0.01) < 1e-3, `what was behind the visitor stands ahead (${behind.position.map((value) => value.toFixed(1))})`);
  assert.ok(Math.abs(Math.atan2(-behind.position[0], -behind.position[2])) < Math.PI / 4, 'inside the view');
  assert.ok(ahead.position[2] < -4 && Math.abs(ahead.position[0]) < 0.01, 'what is already in view stays where it was put');
  // A hunt keeps its objects out of the middle of the view: finding them is the game.
  const hunt = placeOnServer(space, parseExperience({ version: 1, kind: 'hunt', objects: [shape('behind'), shape('ahead')], effects: [],
    stops: [{ ...stops[0], objects: ['behind'], find: { objectId: 'behind', hint: 'Turn around.', found: 'Found.' } }] }), anchors, [floor]);
  assert.ok(hunt.objects[0].position[2] > 4, 'a hunt object behind the visitor stays behind');
});

test('agents learn the looks, effects and sounds a site has', async () => {
  const { experienceCatalog } = await import('../lib/experience/catalog.ts');
  const catalog = experienceCatalog();
  assert.ok(['lines', 'watercolor', 'blueprint', 'noir'].every((id) => catalog.looks.some((look) => look.id === id)));
  assert.deepEqual(catalog.transitions, ['cut', 'fade', 'dissolve', 'wipe', 'iris', 'sweep', 'glitch']);
  assert.ok(!catalog.effects.some((effect) => effect.type === 'sketch'), 'retired effects are left out');
  assert.match(catalog.looks.find((look) => look.id === 'lines').params.join(' '), /weight 0\.6\.\.3 default 1\.3/);
  assert.ok(catalog.sounds.some((sound) => sound.id === 'calm' && sound.kind === 'music'));
});

test('placed objects keep the animation clip they play', () => {
  const experience = parseExperience({ version: 1, kind: 'tour', stops: [], effects: [], objects: [
    { id: 'dog', name: 'Dog', source: { kind: 'model', url: 'https://cdn.example/dog.glb' }, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], animation: '  Wag tail ' },
    { id: 'cat', name: 'Cat', source: { kind: 'model', url: 'https://cdn.example/cat.glb' }, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], animation: 7 }] });
  assert.equal(experience.objects[0].animation, 'Wag tail');
  assert.equal('animation' in experience.objects[1], false);
});

test('capture meshes are read from plain and Draco-compressed glTF binaries', async () => {
  const { parseGlb } = await import('../lib/server/capture-mesh.ts');
  const draco3d = (await import('draco3dgltf')).default;
  // A 10 m square of ground in two triangles, raised by its node to y = 2.
  const positions = new Float32Array([-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, 5]);
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2]);
  const glb = (gltf, bin) => {
    const json = Buffer.from(JSON.stringify(gltf));
    const padded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
    const body = Buffer.concat([bin, Buffer.alloc((4 - bin.length % 4) % 4)]);
    const chunk = (type, data) => { const head = Buffer.alloc(8); head.writeUInt32LE(data.length, 0); head.writeUInt32LE(type, 4); return Buffer.concat([head, data]); };
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 16 + padded.length + body.length, 8);
    return Buffer.concat([header, chunk(0x4e4f534a, padded), chunk(0x004e4942, body)]);
  };
  const base = { asset: { version: '2.0' }, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, translation: [0, 2, 0] }] };
  const plainBin = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer)]);
  const plain = await parseGlb(glb({ ...base, meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: plainBin.length }], bufferViews: [{ buffer: 0, byteLength: 48 }, { buffer: 0, byteOffset: 48, byteLength: 24 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' }, { bufferView: 1, componentType: 5125, count: 6, type: 'SCALAR' }] }, plainBin));

  const encoder = await draco3d.createEncoderModule({});
  const mesh = new encoder.Mesh();
  const builder = new encoder.MeshBuilder();
  builder.AddFacesToMesh(mesh, 2, indices);
  const positionId = builder.AddFloatAttributeToMesh(mesh, encoder.POSITION, 4, 3, positions);
  const out = new encoder.DracoInt8Array();
  const length = new encoder.Encoder().EncodeMeshToDracoBuffer(mesh, out);
  const dracoBin = Buffer.from(Int8Array.from({ length }, (_, index) => out.GetValue(index)).buffer);
  const compressed = await parseGlb(glb({ ...base, extensionsUsed: ['KHR_draco_mesh_compression'], extensionsRequired: ['KHR_draco_mesh_compression'],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: positionId } } } }] }],
    buffers: [{ byteLength: dracoBin.length }], bufferViews: [{ buffer: 0, byteLength: dracoBin.length }],
    accessors: [{ componentType: 5126, count: 4, type: 'VEC3' }, { componentType: 5125, count: 6, type: 'SCALAR' }] }, dracoBin));

  const THREE = await import('three');
  for (const [label, parts] of [['plain', plain], ['Draco', compressed]]) {
    assert.equal(parts.length, 1);
    assert.equal(parts[0].geometry.index.count, 6, `${label}: both triangles`);
    const surface = new THREE.Mesh(parts[0].geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    surface.matrixAutoUpdate = false;
    surface.matrixWorld.copy(parts[0].matrix);
    const hit = new THREE.Raycaster(new THREE.Vector3(1, 10, 1), new THREE.Vector3(0, -1, 0)).intersectObject(surface)[0];
    assert.ok(hit && Math.abs(hit.point.y - 2) < 1e-4, `${label}: a ray finds the ground where its node put it`);
  }
});
