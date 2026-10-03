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
