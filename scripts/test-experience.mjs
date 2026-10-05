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

test('stops can fly up over the 3D map once the space is placed on it', () => {
  const placed = { ...tour(), place: { lat: 30.3216, lon: 35.452, heading: 370, nodeId: 'a', elevation: 2.345, scale: 1 },
    stops: [{ ...tour().stops[0], view: { ...view, earth: { range: 5 } } }, { ...tour().stops[0], id: 'two', view: { ...view, earth: { range: 50000 } } }] };
  const result = parseExperience(placed, { nodeIds: new Set(['a', 'b']) });
  assert.deepEqual(result.place, { lat: 30.3216, lon: 35.452, heading: 10, nodeId: 'a', elevation: 2.35 }, 'heading wraps and scale 1 is left out');
  assert.equal(result.stops[0].view.earth.range, 30, 'too low a view is raised');
  assert.equal(result.stops[1].view.earth.range, 20000, 'too high a view is lowered');
  assert.throws(() => parseExperience({ ...placed, place: { lat: 91, lon: 0 } }), ExperienceError, 'latitude past the pole');
  assert.throws(() => parseExperience({ ...placed, place: { ...placed.place, nodeId: 'gone' } }, { nodeIds: new Set(['a']) }), ExperienceError, 'a place on a removed panorama');
  assert.equal(parseExperience({ ...placed, place: { lat: 'x' } }, { lenient: true }).place, undefined, 'older tours drop a bad place');

  const applied = applyExperience(bootstrap(), result);
  const point = applied.tour.tour_data.spaces[0].tourpoints[0];
  assert.equal(point.viewMode, 'ORBIT', 'a stop above the map orbits it');
  assert.deepEqual(point.earth, { range: 30 });
  assert.equal(normalizeTour(applied).place.lat, 30.3216);
  assert.equal(tourSegment(applied, 0, 0).bootstrap.tour.tour_data.place.lon, 35.452);
  assert.equal(tourSegment(applied, 1, 0).bootstrap.tour.tour_data.place, undefined, 'the place never moves to another space');
  const back = experienceFromBootstrap(applied);
  assert.deepEqual(back.place, result.place);
  assert.equal(back.stops[0].view.viewMode, undefined, 'turning the map off later leaves a plain stop');
  assert.deepEqual(back.stops[0].view.earth, { range: 30 });

  const geo = bootstrap();
  geo.space.space_data.geo = { lat: 1, lon: 2, heading: 0 };
  assert.equal(normalizeTour(geo).place.lat, 1, 'a capture that knows where it is needs no place in the tour');
});

test('the map turns so north lies where the place says', async () => {
  const THREE = await import('three');
  const { earthYaw, bearingOf, earthPose, earthRotation } = await import('../lib/three/earth.ts');
  const { cameraDirection } = await import('../lib/three/math.ts');
  // The map arrives with +Z north and +X west. Heading 90 means a view at azimuth 0 faces east.
  const place = { heading: 90 };
  const turn = new THREE.Matrix4().makeRotationY(earthYaw(place));
  const east = new THREE.Vector3(-1, 0, 0).applyMatrix4(turn);
  const facing = cameraDirection({ azimuth: 0, polar: 0 });
  assert.ok(east.distanceTo(facing) < 1e-9, 'east on the map lies along azimuth 0');
  const north = new THREE.Vector3(0, 0, 1).applyMatrix4(turn);
  assert.ok(north.distanceTo(cameraDirection({ azimuth: 90, polar: 0 })) < 1e-9, 'north lies a quarter turn to the left');
  assert.equal(bearingOf(place, 0), 90);
  assert.equal(bearingOf(place, 90), 0);
  assert.equal(earthRotation({ azimuth: 20, polar: 0 }).polar, -45, 'a level view tips down to see the ground');
  const pose = earthPose(new THREE.Vector3(0, 0, 0), { range: 600 }, { azimuth: 0, polar: -90 }, 1);
  assert.ok(Math.abs(pose.position.length() - 600) < 1e-6);
  assert.ok(pose.position.y > 590, 'the camera stands above the target');
});

test('agent drafts keep the place a person lined up, and suggest one for an unplaced space', () => {
  const previous = parseExperience({ ...tour(), place: { lat: 1, lon: 2, heading: 33 } });
  const raw = { reply: 'ok', kind: 'tour', objects: [], effects: [], place: { lat: 9, lon: 9 },
    stops: [{ id: 'one', title: 'From above', text: 'The valley.', nodeId: 'a', rotation: { azimuth: 0, polar: -50 }, earth: { range: 1500 } }] };
  const kept = normalizeAgentDraft(raw, previous, new Set(['a'])).experience;
  assert.deepEqual(kept.place, { lat: 1, lon: 2, heading: 33 });
  assert.deepEqual(kept.stops[0].view.earth, { range: 1500 });
  const suggested = normalizeAgentDraft(raw, parseExperience(tour()), new Set(['a'])).experience;
  assert.deepEqual(suggested.place, { lat: 9, lon: 9, heading: 0 });
  const removed = normalizeAgentDraft({ ...raw, stops: [{ ...raw.stops[0], earth: null }] }, kept, new Set(['a'])).experience;
  assert.equal(removed.stops[0].view.earth, undefined, 'the agent can bring a stop back down');
  const unchanged = normalizeAgentDraft({ ...raw, stops: [{ ...raw.stops[0], earth: undefined }] }, kept, new Set(['a'])).experience;
  assert.deepEqual(unchanged.stops[0].view.earth, { range: 1500 }, 'a stop the agent leaves alone stays above the map');
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

test('a space with a titled tour is linked by the tour name', async () => {
  const { tourNamedListing } = await import('../lib/scene-edits.ts');
  const listing = { sceneId: 'fedcbafedcba', title: 'The Tomb of Tausert and Setnakht (KV 14)', titleSlug: 'the-tomb-of-tausert-and-setnakht-kv-14',
    scenePath: '/s/fedcbafedcba/the-tomb-of-tausert-and-setnakht-kv-14' };
  store.saveSceneTour('fedcbafedcba', 0, parseExperience({ ...tour(), title: 'The Queen Who Vanished' }));
  store.saveSceneTour('0123456789ab', 0, parseExperience(tour()));
  const titles = store.readSceneTourTitles();
  assert.equal(titles.get('fedcbafedcba'), 'The Queen Who Vanished');
  assert.equal(titles.has('0123456789ab'), false, 'an untitled tour keeps the space name');
  const named = tourNamedListing(listing, titles.get('fedcbafedcba'));
  assert.equal(named.scenePath, '/s/fedcbafedcba/the-queen-who-vanished');
  assert.equal(named.titleSlug, 'the-queen-who-vanished');
  assert.equal(named.title, listing.title, 'the space keeps its own title');
  assert.equal(tourNamedListing(listing, undefined), listing);
  assert.equal(tourNamedListing(listing, '  '), listing);
  store.saveSceneTour('fedcbafedcba', 1, null);
  assert.equal(store.readSceneTourTitles().has('fedcbafedcba'), false, 'removing the tour gives the space its own name back');
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

test('a look redraws the frame the screen would show, so glows blend as they do without one', async () => {
  const THREE = await import('three');
  const { LookPass } = await import('../lib/three/looks/LookPass.ts');
  for (const float of [true, false]) {
    let target = null;
    const drawn = [];
    const renderer = {
      getContext: () => ({ getExtension: () => (float ? {} : null) }),
      getDrawingBufferSize: (out) => out.set(64, 32),
      setRenderTarget: (next) => { target = next; },
      render: (scene) => drawn.push({ scene, target })
    };
    const host = { prepareVariant: async () => false, showVariant() {}, styleSplats() {}, variantReady: () => false };
    const pass = new LookPass(renderer, host, true);
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
    pass.set({ look: 'lines', transition: 'cut' }, camera, null, { instant: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    pass.render(scene, camera, 0);
    const frame = drawn.find((call) => call.scene === scene)?.target;
    assert.ok(frame, 'with a look, the space is drawn offscreen');
    // three.js tone maps and encodes for the screen and for XR targets only; anything else gets linear
    // light, where a halo's additive glow sums before the display curve and turns into a flat disk.
    assert.equal(frame.isXRRenderTarget, true, 'the frame is drawn as an output, like the screen');
    assert.equal(THREE.ColorManagement.getTransfer(frame.texture.colorSpace), THREE.SRGBTransfer, 'materials encode for display into it');
    assert.equal(frame.texture.type, float ? THREE.HalfFloatType : THREE.UnsignedByteType);
    if (!float) assert.equal(frame.texture.internalFormat, 'RGBA8', 'bytes are not stored as sRGB, which would encode them twice');
    const material = [...pass.materials.values()][0];
    assert.equal(material.uniforms.uB_backdrop.value.getHexString(THREE.LinearSRGBColorSpace), 'f4f1e8', 'the paper behind a look is as displayed, like the frame');
    pass.dispose();
  }
});

test('a halo keeps a bounded glow at any strength', async () => {
  const THREE = await import('three');
  // The glow sprite's texture is drawn on a 2D canvas; node has none, and the drawing does not matter here.
  const context2d = { createRadialGradient: () => ({ addColorStop() {} }), fillRect() {}, fillStyle: '' };
  globalThis.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => context2d }) };
  const { default: halo } = await import('../lib/experience/spacery/halo.ts');
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const object = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshBasicMaterial());
  scene.add(object);
  const effect = halo({ scene, camera, object: () => object, anchor: (out) => out.copy(object.position), bounds: (out) => out.setFromObject(object) },
    { id: 'halo', type: 'halo', target: { kind: 'object', id: 'orb' }, params: { color: '#ffe9a8', strength: 2, pulse: 3 } });
  const sprite = scene.children.find((child) => child.isSprite);
  effect.setActive(true);
  let time = 0;
  for (let frame = 0; frame < 60 * 120; frame += 1) {
    time += 1 / 60;
    if (frame % 600 === 0) effect.play('found');
    effect.update({ time, delta: 1 / 60, camera });
    // A sprite opacity that ran off to Infinity made 0 x Infinity = NaN at the sprite's clear corners,
    // which the screen clamps away but a look's frame keeps: a solid square.
    assert.ok(Number.isFinite(sprite.material.opacity) && sprite.material.opacity <= 1, `sprite opacity ${sprite.material.opacity} at frame ${frame}`);
    const rim = object.children[0].material.uniforms.uOpacity.value;
    assert.ok(Number.isFinite(rim) && rim <= 2, `rim opacity ${rim} at frame ${frame}`);
  }
  assert.equal(sprite.material.blending, THREE.AdditiveBlending);
  effect.setActive(false);
  for (let frame = 0; frame < 60 * 5; frame += 1) effect.update({ time: (time += 1 / 60), delta: 1 / 60, camera });
  assert.equal(sprite.visible, false, 'it fades out when its stop is left');
  // Held back for a hint, it lights the object about as long as the hint's beacon stands.
  const lit = (seconds) => { for (let frame = 0; frame < 60 * seconds; frame += 1) effect.update({ time: (time += 1 / 60), delta: 1 / 60, camera }); return sprite.visible; };
  effect.play('hint');
  assert.equal(lit(7), true, 'a hint keeps it glowing');
  assert.equal(lit(4), false, 'and then it fades by itself');
  effect.play('found');
  assert.equal(lit(1), true);
  assert.equal(lit(4), false, 'a find flashes it briefly');
  effect.dispose();
});

test('skies are validated for the tour and each stop, reach the viewer, and agents can set them', () => {
  const input = tour();
  input.sky = { sky: 'drawn-night', turn: 400, brightness: 9, light: 0.5, duration: 2 };
  input.stops[0].sky = 'https://example.com/sky.jpg';
  input.stops.push({ id: 'two', title: 'Two', text: 'As captured', view, objects: [], effects: [], sky: 'none' });
  const parsed = parseExperience(input);
  assert.deepEqual(parsed.sky, { sky: 'drawn-night', turn: 180, brightness: 2.5, light: 0.5 }, 'values are clamped and defaults left out');
  assert.deepEqual(parsed.stops[0].sky, { sky: 'custom', url: 'https://example.com/sky.jpg' }, 'an address is a custom sky');
  assert.deepEqual(parsed.stops[1].sky, { sky: 'none' }, 'a stop can return to the capture\'s own sky');
  assert.throws(() => parseExperience({ ...tour(), sky: { sky: 'mars' } }), /sky this site does not have/);
  assert.throws(() => parseExperience({ ...tour(), sky: { sky: 'custom', url: 'http://example.com/sky.jpg' } }), /https/);
  assert.throws(() => parseExperience({ ...tour(), sky: { sky: 'custom', url: 'javascript:alert(1)' } }), ExperienceError);
  const lenient = parseExperience({ ...tour(), sky: { sky: 'mars' }, stops: [{ ...tour().stops[0], sky: { sky: 'custom' } }] }, { lenient: true });
  assert.equal(lenient.sky, undefined, 'unknown skies are dropped from agent drafts');
  assert.equal(lenient.stops[0].sky, undefined, 'a custom sky without an image is dropped');
  const applied = applyExperience(bootstrap(), parsed);
  assert.equal(applied.tour.tour_data.sky.sky, 'drawn-night');
  assert.equal(applied.tour.tour_data.spaces[0].tourpoints[0].sky.url, 'https://example.com/sky.jpg');
  assert.equal(normalizeTour(applied).sky.turn, 180);
  assert.equal(experienceFromBootstrap(applied).stops[1].sky.sky, 'none', 'skies survive a round trip through the bootstrap');
  const agent = normalizeAgentDraft({ reply: 'ok', kind: 'tour', sky: { sky: 'drawn-sunset', turn: -90 },
    objects: [], effects: [], stops: [{ id: 'one', title: 'One', text: 'Hi', nodeId: 'a', sky: { sky: 'drawn-twilight', light: 0.4 } }, { id: 'two', title: 'Two', text: 'Hi', nodeId: 'a' }] }, parsed, new Set(['a', 'b']));
  assert.deepEqual(agent.experience.sky, { sky: 'drawn-sunset', turn: -90 });
  assert.deepEqual(agent.experience.stops[0].sky, { sky: 'drawn-twilight', light: 0.4 });
  assert.deepEqual(agent.experience.stops[1].sky, { sky: 'none' }, 'a stop the agent leaves alone keeps its sky');
  assert.equal(normalizeAgentDraft({ reply: 'ok', kind: 'tour', objects: [], effects: [], stops: [] }, parsed, new Set(['a'])).experience.sky.sky, 'drawn-night', 'the tour keeps its sky when the agent does not mention one');
});

test('a sky turns to put its sun where a stop looks', async () => {
  const { skySunHeading, skyTurnToward } = await import('../lib/experience/registry.ts');
  const { cameraDirection } = await import('../lib/three/math.ts');
  const { skyImageDirection } = await import('../lib/three/layers/TourSkyLayer.ts');
  const sky = { sun: [0.6034, 0.4924] };
  for (const heading of [-150, -40, 0, 75, 170]) {
    const turn = skyTurnToward(sky, heading);
    const sun = skyImageDirection(sky.sun[0], sky.sun[1], turn);
    const view = cameraDirection({ azimuth: heading, polar: 0 });
    assert.ok(Math.hypot(sun.x - view.x, sun.z - view.z) < 0.03, `the sun faces heading ${heading}`);
  }
  assert.deepEqual(skySunHeading({ sun: [0.5, 0.25] }), { heading: -90, height: 45 });
  assert.equal(skySunHeading({}), null);
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
  const more = [...library, { id: 'cart', name: 'Wooden cart', category: 'Farm', pack: 'Medieval Village (Camelot)', url: 'https://cdn.example/cart.glb', height: 1 },
    { id: 'spice', name: 'Bowl Spice', category: 'Ancient Egypt', url: 'https://cdn.example/bowl.glb', height: 0.1 },
    { id: 'owl', name: 'Barn owl', category: 'Animals', url: 'https://cdn.example/owl.glb', height: 0.3 }];
  assert.deepEqual(searchLibrary(more, 'camel'), [], 'camel is not Camelot');
  assert.deepEqual(searchLibrary(more, 'owls').map((model) => model.id), ['owl'], 'owl is not bowl, and plurals match');
  const { matchModel } = await import('../lib/experience/library-search.ts');
  assert.ok(matchModel(more[0], ['amph'], true).all && !matchModel(more[0], ['amph']).all, 'word beginnings only while someone types in the builder');
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

test('a hunt object hidden from its clue stays where a location a few steps away sees it, and otherwise comes forward', async () => {
  const THREE = await import('three');
  const { placeOnServer } = await import('../lib/server/tour-placement.ts');
  const shape = (id) => ({ id, name: id, source: { kind: 'shape', shape: 'orb' }, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
  const experience = parseExperience({ version: 1, kind: 'hunt', objects: [shape('coin'), shape('cup'), shape('far')], effects: [], stops: [
    { id: 'one', title: 'One', text: 'Find the coin.', view: { nodeId: 'a' }, objects: ['coin'], effects: [], find: { objectId: 'coin', hint: 'Up the step.', found: 'Found.' } },
    { id: 'two', title: 'Two', text: 'Find the cup.', view: { nodeId: 'a' }, objects: ['cup', 'far'], effects: [], find: { objectId: 'cup', hint: 'Behind you.', found: 'Found.' } }] });
  const spaceWith = (b) => ({ space: { id: 'space', title: 'Space', type: 'spaces', space_data: { nodes: [
    { uuid: 'a', position: { x: 0, y: 1.5, z: 0 }, image: 'https://example.com/a.jpg' }, { uuid: 'b', position: b, image: 'https://example.com/b.jpg' }] } } });
  // Open floor, and a two-meter step between the clue's location and the far side.
  const surface = (geometry) => { const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })); mesh.updateMatrixWorld(true); return mesh; };
  const meshes = [surface(new THREE.PlaneGeometry(100, 100).rotateX(-Math.PI / 2)), surface(new THREE.PlaneGeometry(10, 2).translate(0, 1, 3)),
    surface(new THREE.PlaneGeometry(10, 3).rotateX(-Math.PI / 2).translate(0, 2, 4.5))];
  // The coin was picked in the photo from the top of the step, seven meters from the clue's
  // location; the cup in plain view behind the clue's location.
  const anchors = { objects: { coin: { nodeId: 'b', x: 0.75, y: 0.75 }, cup: { nodeId: 'a', x: 0.75, y: 0.6 }, far: { nodeId: 'a', x: 0.75, y: 0.5175 } }, effects: {}, stops: {} };
  const placed = placeOnServer(spaceWith({ x: 0, y: 3.5, z: 7 }), experience, anchors, meshes);
  const [coin, cup, far] = placed.objects;
  assert.ok(Math.abs(coin.position[1] - 2.01) < 1e-3 && coin.position[2] > 4, `a walk up the step finds it, so it stays on top (${coin.position.map((value) => value.toFixed(2))})`);
  assert.ok(Math.abs(cup.position[1]) < 0.02 && cup.position[2] < -4, 'what the visitor can already see stays where it was put');
  assert.ok(Math.abs(Math.hypot(far.position[0], far.position[2]) - 18) < 0.5 && Math.abs(far.position[1] - 0.01) < 1e-3, `far across the space it comes to 18 meters along the same line (${far.position.map((value) => value.toFixed(1))})`);
  // Seen only from a location twenty meters off, it comes down in front of the step instead.
  const [hidden] = placeOnServer(spaceWith({ x: 0, y: 3.5, z: 20 }), experience, anchors, meshes).objects;
  assert.ok(Math.abs(hidden.position[1] - 0.01) < 1e-3 && hidden.position[2] > 2 && hidden.position[2] < 3, `no location nearby sees it, so it comes forward (${hidden.position.map((value) => value.toFixed(2))})`);
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

test('a tour stop high above its objects turns toward them', async () => {
  const { frameStops, inFrame } = await import('../lib/server/tour-placement.ts');
  assert.ok(inFrame({ azimuth: 0, polar: 0 }, { azimuth: -30, polar: -20 }), 'right of center and a little below is framed');
  assert.ok(!inFrame({ azimuth: 0, polar: 0 }, { azimuth: 25, polar: 0 }), 'the left, under the text on wide screens, is not');
  const space = { space: { id: 'space', title: 'Space', type: 'spaces', space_data: { nodes: [{ uuid: 'a', position: { x: 0, y: 20, z: 0 }, image: 'https://example.com/a.jpg' }] } } };
  const experience = parseExperience({ version: 1, kind: 'tour', effects: [],
    objects: [{ id: 'cart', name: 'Cart', source: { kind: 'shape', shape: 'box' }, position: [0, 0, -15], rotation: [0, 0, 0], scale: [1, 1, 1] }],
    stops: [{ id: 'one', title: 'Over the arena', text: 'Look out.', view: { nodeId: 'a', rotation: { azimuth: 0, polar: 5 } }, objects: ['cart'], effects: [] },
      { id: 'two', title: 'Again', text: 'Look down.', view: { nodeId: 'a', rotation: { azimuth: 0, polar: -40 } }, objects: ['cart'], effects: [] }] });
  const [one, two] = frameStops(space, experience);
  assert.ok(one.view.rotation.polar < -20 && one.view.rotation.polar >= -35, `it tilts down toward the cart (${one.view.rotation.polar})`);
  assert.ok(inFrame(one.view.rotation, { azimuth: 0, polar: -51.6 }) || one.view.rotation.polar === -35, 'the cart is in its frame');
  assert.ok(one.view.rotation.azimuth > 0, 'the cart sits right of center');
  assert.deepEqual(two.view.rotation, { azimuth: 0, polar: -40 }, 'a stop that already shows its objects keeps its view');
});

test('in a space without panoramas, the agent points into views drawn on the server', async () => {
  const { pointInView } = await import('../lib/server/space-views.ts');
  const { placeOnServer } = await import('../lib/server/tour-placement.ts');
  // A view from 1.5 m up looking level at a wall 5 m away (depth along the view is 5 everywhere).
  const view = { id: 's1', camera: { position: [0, 1.5, 0], azimuth: 0, polar: 0, fov: 60 }, width: 960, height: 640, image: '', depth: new Float32Array(960 * 640).fill(5) };
  const middle = pointInView(view, 0.5, 0.5);
  assert.ok(middle.point.distanceTo({ x: 0, y: 1.5, z: -5 }) < 0.02, 'the pixel in the middle is on the wall straight ahead');
  assert.ok(middle.normal.z > 0.99, 'and the wall faces the camera');
  // Holes in a drawing are bridged from the nearest drawn pixel.
  const holed = { ...view, depth: view.depth.slice() };
  for (let y = 300; y < 340; y++) for (let x = 460; x < 500; x++) holed.depth[y * 960 + x] = Infinity;
  assert.ok(pointInView(holed, 0.5, 0.5) === null || pointInView({ ...holed }, 0.5, 0.5).point.z < -4.9, 'a small hole is bridged or skipped');
  const space = { space: { id: 'space', title: 'Space', type: 'splat', space_data: { noPanos: true, splats: [] } } };
  const experience = parseExperience({ version: 1, kind: 'tour', effects: [],
    objects: [{ id: 'urn', name: 'Urn', source: { kind: 'shape', shape: 'orb' }, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }],
    stops: [{ id: 'one', title: 'One', text: 'Look.', view: { rotation: { azimuth: 0, polar: 0 } }, objects: ['urn'], effects: [] }] });
  const placed = placeOnServer(space, experience, { objects: { urn: { view: 's1', x: 0.5, y: 0.5 } }, stops: { one: { view: 's1', x: 0.75, y: 0.5 } }, effects: {} }, [], [view]);
  assert.ok(Math.abs(placed.objects[0].position[2] + 4.94) < 0.02, `the urn stands just off the wall (${placed.objects[0].position})`);
  assert.deepEqual(placed.stops[0].view.position, { x: 0, y: 1.5, z: 0 }, 'the stop stands where the view was drawn from');
  assert.ok(placed.stops[0].view.rotation.azimuth < -10, 'and looks toward the pixel it was given, right of center');
});

test('agents learn the looks, effects and sounds a site has', async () => {
  const { experienceCatalog } = await import('../lib/experience/catalog.ts');
  const catalog = experienceCatalog();
  assert.ok(['lines', 'watercolor', 'blueprint', 'noir'].every((id) => catalog.looks.some((look) => look.id === id)));
  assert.deepEqual(catalog.transitions, ['cut', 'fade', 'dissolve', 'wipe', 'iris', 'sweep', 'glitch']);
  assert.ok(!catalog.effects.some((effect) => effect.type === 'sketch'), 'retired effects are left out');
  assert.match(catalog.looks.find((look) => look.id === 'lines').params.join(' '), /weight 0\.6\.\.3 default 1\.3/);
  assert.ok(catalog.sounds.some((sound) => sound.id === 'calm' && sound.kind === 'music'));
  assert.ok(['day', 'sunset', 'dusk', 'night', 'cloudy'].every((kind) => catalog.skies.some((sky) => sky.kind === kind)), 'every kind of sky is offered');
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

test('stops can show the site reconstruction or the capture, and keep what shows when they say nothing', () => {
  const stops = [
    { ...tour().stops[0], id: 'then', view: { ...view, reconstruction: true } },
    { ...tour().stops[0], id: 'now', view: { ...view, reconstruction: false } },
    { ...tour().stops[0], id: 'same', view: { ...view, reconstruction: 'yes' } }
  ];
  const result = parseExperience({ ...tour(), stops }, { nodeIds: new Set(['a', 'b']) });
  assert.equal(result.stops[0].view.reconstruction, true);
  assert.equal(result.stops[1].view.reconstruction, false, 'false is kept, so a stop can bring the capture back');
  assert.equal('reconstruction' in result.stops[2].view, false, 'anything but true or false is dropped');

  const applied = applyExperience(bootstrap(), result);
  const points = applied.tour.tour_data.spaces[0].tourpoints;
  assert.deepEqual(points.map((point) => point.reconstruction), [true, false, undefined]);
  assert.equal('reconstruction' in points[2], false);
  const back = experienceFromBootstrap(applied);
  assert.deepEqual(back.stops.map((stop) => stop.view.reconstruction), [true, false, undefined]);

  const previous = parseExperience({ ...tour(), stops: [stops[0]] });
  const raw = { reply: 'ok', kind: 'tour', objects: [], effects: [], stops: [{ id: 'then', title: 'Then', text: 'Painted.', nodeId: 'a' }] };
  assert.equal(normalizeAgentDraft(raw, previous, new Set(['a'])).experience.stops[0].view.reconstruction, true, 'a stop the agent leaves alone keeps it');
  assert.equal(normalizeAgentDraft({ ...raw, stops: [{ ...raw.stops[0], reconstruction: false }] }, previous, new Set(['a'])).experience.stops[0].view.reconstruction, false);
  assert.equal(normalizeAgentDraft({ ...raw, stops: [{ ...raw.stops[0], reconstruction: null }] }, previous, new Set(['a'])).experience.stops[0].view.reconstruction, undefined, 'null takes the choice away');
  assert.equal(normalizeAgentDraft({ ...raw, stops: [{ ...raw.stops[0], id: 'new', reconstruction: true }] }, previous, new Set(['a'])).experience.stops[0].view.reconstruction, true);
});

test('a reconstruction manifest is found beside the capture and given to the opening space only', async () => {
  const { reconstructionUrl } = await import('../lib/server/reconstructions.ts');
  const before = process.env.SPHR_RECONSTRUCTIONS_BASE_URL;
  process.env.SPHR_RECONSTRUCTIONS_BASE_URL = 'https://static.example/reconstructions/';
  try {
    assert.equal(reconstructionUrl('0123456789ab'), 'https://static.example/reconstructions/0123456789ab/index.json');
    assert.equal(reconstructionUrl('../etc/passwd'), null, 'only scene IDs make an address');
  } finally {
    if (before === undefined) delete process.env.SPHR_RECONSTRUCTIONS_BASE_URL; else process.env.SPHR_RECONSTRUCTIONS_BASE_URL = before;
  }
  delete process.env.SPHR_RECONSTRUCTIONS_BASE_URL;
  assert.equal(reconstructionUrl('0123456789ab'), null, 'without the setting, spaces show only their capture');
  if (before !== undefined) process.env.SPHR_RECONSTRUCTIONS_BASE_URL = before;

  const url = 'https://static.example/reconstructions/0123456789ab/index.json';
  const edited = applySceneEdits(bootstrap(), { title: null, startView: null, reconstruction: url });
  assert.equal(edited.space.space_data.reconstruction, url);
  assert.equal(edited.orderedSpaces.find((space) => space.id === 'space').space_data.reconstruction, url);
  assert.equal(edited.orderedSpaces.find((space) => space.id === 'other').space_data.reconstruction, undefined, 'other spaces have their own coordinates');
  assert.equal(tourSegment(edited, 0, 0).bootstrap.space.space_data.reconstruction, url);
  const own = bootstrap();
  own.orderedSpaces[0].space_data.reconstruction = 'https://package.example/own.json';
  assert.equal(applySceneEdits(own, { title: null, startView: null, reconstruction: url }).space.space_data.reconstruction, 'https://package.example/own.json', 'a package keeps its own');
  assert.equal(applySceneEdits(bootstrap(), { title: null, startView: null, reconstruction: null }).space.space_data.reconstruction, undefined);
});

test('reconstruction manifests are checked before the viewer loads them', async () => {
  const { parseReconstruction, reconstructionModelUrl } = await import('../lib/reconstruction.ts');
  const manifest = { version: 1, title: '  The Sanctuary\nof Poseidon  ', model: 'site.glb', position: [1, 2, 3], quaternion: [0, 0, 0, 1], scale: 1, credit: 'Stylized',
    landmarks: [{ name: 'Temple', position: [0, 5, 0] }, { name: '', position: [0, 0, 0] }, { name: 'Altar', position: [0, 'x', 0] }] };
  const parsed = parseReconstruction(manifest);
  assert.equal(parsed.title, 'The Sanctuary of Poseidon');
  assert.deepEqual(parsed.landmarks, [{ name: 'Temple', position: [0, 5, 0] }], 'unnamed or misplaced landmarks are dropped');
  assert.equal(parseReconstruction({ ...manifest, version: 2 }), null);
  assert.equal(parseReconstruction({ ...manifest, model: '' }), null);
  assert.equal(parseReconstruction({ ...manifest, position: [1, 2] }), null, 'a bad placement makes it unusable');
  assert.equal(parseReconstruction({ ...manifest, quaternion: [0, 0, 0, 0] }), null);
  assert.equal(parseReconstruction({ ...manifest, scale: -1 }), null);
  assert.equal(parsed.sky, undefined, 'without sky colors the viewer uses its own');
  assert.deepEqual(parseReconstruction({ ...manifest, sky: { zenith: '#5F95CF', horizon: 'blue' } }).sky, { zenith: '#5f95cf' }, 'only #rrggbb colors are kept');
  const page = 'https://app.example/s/0123456789ab/site';
  assert.equal(reconstructionModelUrl(parsed, 'https://static.example/r/0123456789ab/index.json', page), 'https://static.example/r/0123456789ab/site.glb', 'relative to the manifest');
  assert.equal(reconstructionModelUrl({ ...parsed, model: 'javascript:alert(1)' }, null, page), null);
  assert.equal(reconstructionModelUrl({ ...parsed, model: 'http://evil.example/site.glb' }, null, page), null, 'plain http only on this computer');
  assert.equal(reconstructionModelUrl(parsed, 'http://localhost:3083/reconstructions-test/0123456789ab/index.json', 'http://localhost:3083/s/x'), 'http://localhost:3083/reconstructions-test/0123456789ab/site.glb');
});

test('the tour agent hears of a reconstruction and its landmarks', async () => {
  const { buildAgentContext } = await import('../lib/server/tour-agent.ts');
  const space = { space: { id: 'space', title: 'Sanctuary', type: 'model', space_data: { noPanos: true } } };
  const without = await buildAgentContext(space, parseExperience(tour()), [], 'http://localhost');
  assert.doesNotMatch(without.text, /Reconstruction/);
  const told = await buildAgentContext(space, parseExperience(tour()), [], 'http://localhost', false, '', [], [], { title: 'The Sanctuary about 440 BC', landmarks: ['Temple of Poseidon', 'Great Altar'] });
  assert.match(told.text, /"The Sanctuary about 440 BC", with Temple of Poseidon, Great Altar/);
  assert.match(told.text, /"reconstruction": true/);
});

test('objects can open a link, and tours can set their text over the view', () => {
  const withLink = (link) => ({ ...tour(), objects: [{ id: 'portal', name: 'Portal', source: { kind: 'shape', shape: 'orb' }, position: [0, 1, 0], label: 'Go to the next tour', link }, ...tour().objects] });
  const result = parseExperience(withLink('https://app.spacery.dev/s/ffa3cb6c9d16/explore-the-tomb-of-queen-meresankh-iii'), { nodeIds: new Set(['a', 'b']) });
  assert.equal(result.objects[0].link, 'https://app.spacery.dev/s/ffa3cb6c9d16/explore-the-tomb-of-queen-meresankh-iii');
  assert.equal(parseExperience(withLink('/s/ffa3cb6c9d16'), { nodeIds: new Set(['a', 'b']) }).objects[0].link, '/s/ffa3cb6c9d16');
  assert.throws(() => parseExperience(withLink('javascript:alert(1)'), { nodeIds: new Set(['a', 'b']) }), ExperienceError);
  assert.equal(parseExperience(withLink('javascript:alert(1)'), { lenient: true }).objects[0].link, undefined, 'a lenient draft drops a bad link and keeps the object');
  const base = { space: { id: 's', title: 'Space', space_data: { nodes: [{ uuid: 'a', position: { x: 0, y: 1.6, z: 0 } }] } },
    tour: { tour_data: { mode: 'guided', spaces: [{ id: 's', tourpoints: [{ nodeUUID: 'a', text: 'Hi' }] }] } } };
  assert.equal(normalizeTour(base).textStyle, 'panel');
  base.tour.tour_data.textStyle = 'gradient';
  assert.equal(normalizeTour(base).textStyle, 'gradient');
  base.tour.tour_data.textStyle = 'neon';
  assert.equal(normalizeTour(base).textStyle, 'panel');
});

test('a guided tour can continue to another page after its last stop', () => {
  const base = (continueTo, mode = 'guided') => ({ space: { id: 's', title: 'Space', space_data: { nodes: [{ uuid: 'a', position: { x: 0, y: 1.6, z: 0 } }] } },
    tour: { tour_data: { mode, continueTo, spaces: [{ id: 's', tourpoints: [{ nodeUUID: 'a', text: 'Hi' }] }] } } });
  assert.deepEqual(normalizeTour(base({ url: '/s/5b073eb82f3f/the-great-sphinx-of-giza', label: ' Continue to the Great Sphinx ' })).continueTo,
    { url: '/s/5b073eb82f3f/the-great-sphinx-of-giza', label: 'Continue to the Great Sphinx' });
  assert.equal(normalizeTour(base({ url: 'https://mused.com/edu/', label: 'Open the school library' })).continueTo.url, 'https://mused.com/edu/');
  assert.equal(normalizeTour(base({ url: 'javascript:alert(1)', label: 'Go' })).continueTo, undefined);
  assert.equal(normalizeTour(base({ url: '//evil.example/', label: 'Go' })).continueTo, undefined);
  assert.equal(normalizeTour(base({ url: 'http://mused.com/edu/', label: 'Go' })).continueTo, undefined);
  assert.equal(normalizeTour(base({ url: '/s/x', label: '  ' })).continueTo, undefined);
  assert.equal(normalizeTour(base({ url: '/s/x', label: 'Go' }, 'explore')).continueTo, undefined, 'free exploration has no last stop');
});

test('effects can hold back for a find, a hint or a click, so a hunt celebrates only the find', async () => {
  const THREE = await import('three');
  const { EffectsLayer } = await import('../lib/three/layers/EffectsLayer.ts');
  const { experienceCatalog } = await import('../lib/experience/catalog.ts');
  const { effectEntry } = await import('../lib/experience/packs.ts');
  const { resolveParams } = await import('../lib/experience/registry.ts');
  const { SYSTEM, buildAgentContext } = await import('../lib/server/tour-agent.ts');

  // Agents see the trigger, and what it does, wherever they read the site's effects.
  const catalog = experienceCatalog();
  for (const type of ['confetti', 'sparkles', 'ripple', 'bloom', 'halo', 'beacon', 'scan']) {
    assert.match(catalog.effects.find((effect) => effect.type === type).params.join(', '), /trigger one of stop\|found\|hint\|click default stop \(stop runs with its stop .+ holds it back until that moment alone\)/, type);
  }
  assert.match(catalog.effects.find((effect) => effect.type === 'sound').params.join(', '), /trigger one of enter\|loop\|found\|click\|hint default enter,/, 'sounds keep their own');
  assert.match(SYSTEM, /aim it at the hunt object with "trigger": "found"/, 'the drafting agent celebrates finds with it');
  const context = await buildAgentContext({ space: { id: 'space', title: 'Tomb', type: 'model', space_data: { noPanos: true } } }, parseExperience(tour()), [], 'http://localhost');
  assert.match(context.text, /confetti \(Confetti\): .+ Params .*trigger one of stop\|found\|hint\|click default stop/);

  // Saved tours keep a trigger the effect knows; older ones, and unknown values, play with their stop.
  const coin = { id: 'coin', name: 'Coin', source: { kind: 'shape', shape: 'coin' }, position: [2, 0, -3], rotation: [0, 0, 0], scale: [1, 1, 1] };
  const saved = parseExperience({ version: 1, kind: 'hunt', objects: [coin], effects: [
    { id: 'party', type: 'confetti', target: { kind: 'object', id: 'coin' }, params: { trigger: 'found' } },
    { id: 'older', type: 'confetti', target: { kind: 'object', id: 'coin' }, params: { palette: 'gold' } },
    { id: 'odd', type: 'ripple', target: { kind: 'object', id: 'coin' }, params: { trigger: 'enter' } }],
  stops: [{ id: 'one', title: 'One', text: 'Find the coin.', view: { nodeId: 'a' }, objects: [], effects: ['party'], find: { objectId: 'coin' } }] });
  assert.deepEqual(saved.effects.map((effect) => effect.params.trigger), ['found', 'stop', 'stop']);

  // The viewer's effects layer running the packs' own effect code, over a coin that lifts away when collected.
  const effect = (id, type, target, params = {}) => ({ id, type, target, params: resolveParams(effectEntry(type), params) });
  const onCoin = { kind: 'object', id: 'coin' };
  let lift = 0;
  const objects = { getHolder: () => new THREE.Object3D(), bounds: (id, out) => out.setFromCenterAndSize(new THREE.Vector3(2, 0.2 + lift, -3), new THREE.Vector3(0.3, 0.4, 0.3)) };
  const layers = [];
  const viewer = async (effects, listed) => {
    const scene = new THREE.Scene();
    const layer = new EffectsLayer({ scene, camera: new THREE.PerspectiveCamera(), renderer: null, objects, surfaces: () => [], spaceBounds: (out) => out.makeEmpty(),
      splats: () => null, panorama: () => null, viewMode: () => 'FPV', audio: () => { throw new Error('No audio here.'); } });
    layers.push(layer);
    await layer.setEffects(effects);
    layer.activate(listed);
    return { scene, layer, run: (seconds = 0.3) => { for (let time = 0; time < seconds; time += 0.05) layer.update(time, 0.05); } };
  };
  const pieces = (scene) => scene.children.filter((child) => child.isInstancedMesh).reduce((sum, mesh) => sum + mesh.count, 0);
  const window = globalThis.window;
  const warn = console.warn;
  globalThis.window = { devicePixelRatio: 1 };
  console.warn = () => {};
  try {
    // Confetti for the find, listed on its clue's stop: nothing when the stop opens, a hint or a click, a burst on the find.
    let { scene, layer, run } = await viewer([effect('party', 'confetti', onCoin, { trigger: 'found' })], ['party']);
    run();
    assert.equal(pieces(scene), 0, 'its stop opening throws nothing, so it gives nothing away');
    assert.equal(layer.cue('coin', 'hint'), false, 'a hint passes it by, and the viewer lights the coin up itself');
    assert.equal(layer.cue('coin', 'click'), false);
    run();
    assert.equal(pieces(scene), 0);
    assert.equal(layer.cue('coin', 'found'), true, 'the find throws it, in place of the viewer\'s own sparkles');
    run();
    assert.ok(pieces(scene) > 100, `the find throws the confetti (${pieces(scene)} pieces)`);
    run(5);
    assert.equal(pieces(scene), 0, 'and it all lands and fades');

    // Left at the default, it runs with its stop and answers every cue, as before.
    ({ scene, layer, run } = await viewer([effect('party', 'confetti', onCoin)], ['party']));
    run();
    assert.ok(pieces(scene) > 100, 'it bursts when its stop opens');
    run(5);
    assert.equal(layer.cue('coin', 'hint'), true);
    run();
    assert.ok(pieces(scene) > 100, 'and again for a hint');

    // Held back for a find, at a spot or over the whole space, it plays for the find of a stop that lists it.
    const spot = { kind: 'point', position: [1, 0, -2] };
    ({ scene, layer, run } = await viewer([effect('spot', 'confetti', spot, { trigger: 'found' }), effect('elsewhere', 'confetti', spot, { trigger: 'found' })], ['spot']));
    run();
    assert.equal(pieces(scene), 0);
    assert.equal(layer.cue('coin', 'found'), true);
    run();
    const thrown = pieces(scene);
    assert.ok(thrown > 100 && thrown <= 160, `only the listed one throws (${thrown} pieces)`);
    ({ scene, layer, run } = await viewer([effect('next', 'confetti', { kind: 'object', id: 'cup' }, { trigger: 'found' })], ['next']));
    layer.cue('coin', 'found');
    run();
    assert.equal(pieces(scene), 0, 'one aimed at another hunt object waits for that object, so it never shows where it hides');
    ({ layer } = await viewer([effect('fanfare', 'sound', { kind: 'scene' }, { sound: 'fanfare', trigger: 'found' })], ['fanfare']));
    assert.equal(layer.hasSound('coin', 'found'), true, 'a find sound on the stop replaces the viewer\'s chime');
    assert.equal(layer.hasSound('coin', 'hint'), false);
    layer.activate([]);
    assert.equal(layer.hasSound('coin', 'found'), false, 'but only on its stop');

    // What a cue shows decides whether the viewer adds its own: a beacon lights hints, not finds; sparkles that follow the pointer burst on finds.
    ({ layer } = await viewer([effect('light', 'beacon', onCoin)], []));
    assert.equal(layer.cue('coin', 'found'), false, 'a hint beacon leaves the find to the viewer\'s sparkles');
    assert.equal(layer.cue('coin', 'hint'), true);
    ({ layer } = await viewer([effect('trail', 'sparkles', onCoin, { mode: 'hover' })], ['trail']));
    assert.equal(layer.cue('coin', 'hint'), false, 'pointer sparkles leave the hint to the viewer\'s beacon');
    assert.equal(layer.cue('coin', 'found'), true);

    // Ground ripples for the find stay where the coin was while it flies off, and the builder can play one early.
    ({ scene, layer, run } = await viewer([effect('rings', 'ripple', onCoin, { trigger: 'found' }), effect('later', 'ripple', onCoin, { trigger: 'hint' })], ['rings']));
    const rings = scene.children.filter((child) => child.material?.uniforms?.uRings);
    run();
    assert.ok(rings.every((mesh) => !mesh.visible), 'no rings before the find');
    assert.equal(layer.cue('coin', 'found'), true);
    lift = 2;
    run(1);
    const shown = rings.filter((mesh) => mesh.visible);
    assert.equal(shown.length, 1, 'only the find\'s rings spread');
    assert.ok(Math.abs(shown[0].position.y - 0.02) < 1e-6 && Math.abs(shown[0].position.x - 2) < 1e-6, `on the floor where the coin stood (${shown[0].position.y.toFixed(2)})`);
    lift = 0;
    assert.equal(layer.preview('later'), true, 'the builder plays an effect held back for a hint');
    assert.equal(layer.preview('missing'), false);
    ({ layer } = await viewer([effect('party', 'confetti', onCoin)], []));
    assert.equal(layer.preview('party'), false, 'one that plays with its stop has nothing to preview');
  } finally {
    for (const layer of layers) layer.dispose();
    console.warn = warn;
    if (window === undefined) delete globalThis.window; else globalThis.window = window;
  }
});

test('reconstruction periods survive validation and a tour editor round trip', async () => {
  const { parseReconstruction } = await import('../lib/reconstruction.ts');
  const manifest = parseReconstruction({ model: 'site.glb', variants: [
    { id: 'early', title: 'Early period' }, { id: 'late', title: 'Late period' },
    { id: 'late', title: 'Duplicate' }, { id: '../bad', title: 'Invalid' }
  ] });
  assert.deepEqual(manifest.variants, [{ id: 'early', title: 'Early period' }, { id: 'late', title: 'Late period' }]);
  const raw = tour(); raw.stops[0].view = { ...view, reconstruction: true, reconstructionVariant: 'late' };
  const parsed = parseExperience(raw);
  const applied = applyExperience(bootstrap(), parsed);
  assert.equal(normalizeTour(applied).spaces[0].tourpoints[0].reconstructionVariant, 'late');
  assert.equal(experienceFromBootstrap(applied).stops[0].view.reconstructionVariant, 'late');
  assert.equal(normalizeAgentDraft({ ...raw, stops: [{ ...raw.stops[0], nodeId: 'a' }] }, parsed, new Set(['a'])).experience.stops[0].view.reconstructionVariant, 'late');
});

test('a reconstruction hides capture and environmental models through transitions, while exhibits remain visible', async () => {
  const THREE = await import('three');
  const { SceneGraphLayer } = await import('../lib/three/layers/SceneGraphLayer.ts');
  const scene = new THREE.Scene();
  const layer = new SceneGraphLayer(scene, [
    { id: 'capture', type: 'model', file: 'capture.glb', raycast: true, persistent: true, transitionMesh: true },
    { id: 'landscape', type: 'model', file: 'landscape.glb', replacedByReconstruction: true, persistent: true },
    { id: 'exhibit', type: 'model', file: 'exhibit.glb', persistent: true }
  ]);
  layer.loader.loadAsync = async () => {
    const group = new THREE.Group(); group.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
    return { scene: group };
  };
  await layer.init(); layer.setViewMode('ORBIT');
  const env = new THREE.CubeTexture();
  assert.ok(layer.showNavigationTransition(env));
  layer.setCaptureOpacity(0);
  assert.equal(layer.getObject('capture').visible, false, 'an already-running projection also disappears');
  assert.equal(layer.getObject('landscape').visible, false, 'persistent scenery gives way');
  assert.equal(layer.getObject('exhibit').visible, true, 'unrelated exhibits stay');
  layer.restoreNavigationTransition();
  assert.equal(layer.showNavigationTransition(env), null, 'projection cannot re-show a replaced capture');
  layer.showOnly(['landscape']); layer.setViewMode('FPV'); layer.setOverviewReturnBlend(0.5);
  assert.equal(layer.getObject('landscape').visible, false, 'later stop and view updates cannot reveal it');
  assert.equal(layer.getRaycastObjects().length, 1, 'the hidden survey remains available for capture navigation');
  layer.setCaptureOpacity(1); layer.setViewMode('ORBIT'); layer.setOverviewReturnBlend(null);
  assert.equal(layer.getObject('capture').visible, true); assert.equal(layer.getObject('landscape').visible, true);
  layer.dispose(); env.dispose();
});

test('only the selected reconstruction period participates in surface hits', async () => {
  const THREE = await import('three');
  const { ReconstructionLayer } = await import('../lib/three/layers/ReconstructionLayer.ts');
  const layer = new ReconstructionLayer(new THREE.Scene(), { version: 1, model: 'site.glb', variants: [
    { id: 'early', title: 'Early' }, { id: 'late', title: 'Late' }
  ] });
  const meshes = ['early', 'late'].map((id) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    mesh.userData.reconstructionVariant = id; layer.group.add(mesh); return mesh;
  });
  layer.meshes.push(...meshes); layer.variantNodes.push(...meshes); layer.group.visible = true;
  layer.setVariant('early'); assert.deepEqual(layer.getRaycastObjects(), [meshes[0]]);
  layer.setVariant('late'); assert.deepEqual(layer.getRaycastObjects(), [meshes[1]]);
  layer.setVariant('unknown'); assert.equal(layer.selectedVariant, 'early'); assert.deepEqual(layer.getRaycastObjects(), [meshes[0]]);
  layer.dispose();
});

test('reconstruction atmospheres validate finite physical parameters without changing older manifests', async () => {
  const { parseReconstruction } = await import('../lib/reconstruction.ts');
  const manifest = { version: 1, model: 'site.glb' };
  assert.equal(parseReconstruction(manifest).environment, undefined);
  for (const invalid of [null, true, 'fog', []]) assert.equal(parseReconstruction({ ...manifest, environment: invalid }).environment, undefined);
  const parsed = parseReconstruction({ ...manifest, environment: {
    sun: { azimuth: Infinity, elevation: -100, intensity: 999, color: '#FFF1DA' },
    sky: { clouds: 12, turbidity: NaN },
    fog: { density: -1, height: 0, ground: -30, anisotropy: 9, shafts: 99, color: 'transparent' },
    ground: { radius: 1e9, height: -52, relief: -1 }
  } }).environment;
  assert.deepEqual(parsed.sun, { azimuth: 125, elevation: 5, color: '#fff1da', intensity: 8 });
  assert.equal(parsed.sky.clouds, 0.6);
  assert.equal(parsed.sky.turbidity, 4);
  assert.deepEqual(parsed.fog, { color: '#c9c4b5', density: 0, height: 10, ground: -30, anisotropy: 0.85, shafts: 2 });
  assert.equal(parsed.ground.radius, 15000, 'absurd input uses the bounded default');
  assert.equal(parsed.ground.height, -52);
  assert.equal(parsed.ground.relief, 0);
  const optional = parseReconstruction({ ...manifest, environment: {} }).environment;
  assert.equal(optional.ground, undefined, 'no extra terrain unless explicitly requested');
  assert.ok(optional.fog.density > 0 && optional.fog.density < 0.001);
});

test('a reconstruction environment hides completely with the capture and releases its scene objects', async () => {
  const THREE = await import('three');
  const { parseReconstructionEnvironment } = await import('../lib/reconstruction.ts');
  const { ReconstructionEnvironment } = await import('../lib/three/layers/ReconstructionEnvironment.ts');
  const scene = new THREE.Scene();
  const site = new THREE.Group();
  site.position.set(15, 4, -20); site.rotation.y = Math.PI / 2; site.scale.setScalar(2);
  scene.add(site); site.updateMatrixWorld(true);
  const environment = new ReconstructionEnvironment(scene, site, parseReconstructionEnvironment({ ground: { height: -10 } }));
  const originalChildren = scene.children.length;
  assert.ok(originalChildren > 1);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 20000);
  camera.position.set(20, 6, -20); camera.lookAt(15, 6, -20); camera.updateMatrixWorld(true);
  environment.setOpacity(1); environment.setSky(1); environment.update(camera);
  assert.equal(scene.getObjectByName('reconstruction-sun').visible, true);
  assert.equal(scene.getObjectByName('reconstruction-daylight-sky').visible, true);
  assert.deepEqual(site.children, [], 'distant ground never expands the navigable model or its bounds');
  const backdrop = scene.getObjectByName('reconstruction-environment'); backdrop.updateMatrixWorld(true);
  assert.deepEqual(backdrop.matrixWorld.elements, site.matrixWorld.elements, 'backdrop uses the same authored placement');
  environment.setOpacity(0); environment.setSky(0);
  assert.equal(scene.getObjectByName('reconstruction-sun').visible, false);
  assert.equal(scene.getObjectByName('reconstruction-daylight-sky').visible, false);
  assert.equal(backdrop.visible, false);
  assert.equal(environment.render({}, camera, []), false, 'captured views do not allocate targets or run atmospheric passes');
  environment.dispose();
  assert.deepEqual(scene.children, [site], 'leaving a viewer removes every atmosphere-owned scene object');
});
