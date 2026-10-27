// What search engines read on space, tour and hunt pages (lib/search-page.ts).
//   node --test scripts/test-search-pages.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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

const { fitText, htmlParagraphs, kindLine, pageDescription, pageJsonLd, pageTitle, plainCopy, searchSource, searchText } = await import('../lib/search-page.ts');

const plainRules = /[:;–—]/;

test('titles and descriptions keep to the house style', () => {
  assert.equal(plainCopy('It was 481 feet tall – the tallest; for years: until 1311–1884.'), 'It was 481 feet tall, the tallest, for years, until 1311 to 1884.');
  assert.equal(plainCopy('A well-known hall - with a view'), 'A well-known hall, with a view', 'hyphens inside words stay');
  assert.equal(plainCopy('  Opens at 10:30 —  '), 'Opens at 10:30', 'a clock time is not a colon between words');
  assert.equal(plainCopy('A peak of 2,457 meters , then ; more'), 'A peak of 2,457 meters, then, more', 'numbers keep their commas');
});

test('a hunt or tour is titled by its own name and its space, within 60 characters', () => {
  const brand = 'Sites';
  assert.equal(pageTitle({ name: 'Save the Scrolls', place: 'The Byzantine Church, Petra, Jordan', kind: 'hunt', brand }), 'Save the Scrolls, a hunt in the Byzantine Church, Petra');
  assert.equal(pageTitle({ name: 'Through the Siq', place: 'The Siq, Petra, Jordan', kind: 'tour', brand }), 'Through the Siq, a tour of the Siq, Petra, Jordan · Sites');
  assert.equal(pageTitle({ name: 'The Royal Tombs', place: 'The Royal Tombs, Petra, Jordan', kind: 'tour', brand }), 'The Royal Tombs, Petra, Jordan, a guided tour · Sites',
    'a tour named after its space says it is the tour');
  assert.equal(pageTitle({ name: 'Mount Parnassus, Greece', place: 'Mount Parnassus, Greece', kind: 'space', brand }), 'Mount Parnassus, Greece · Sites');
  const long = pageTitle({ name: 'The explorer who found Petra in disguise lost his satchel', place: 'The Royal Tombs, Petra, Jordan', kind: 'hunt', brand });
  assert.equal(long, 'The explorer who found Petra in disguise lost his satchel', 'a long name stands alone');
  const huge = pageTitle({ name: 'A very long title that goes on and on about every single thing in the hall', place: 'Hall', kind: 'space', brand });
  assert.ok(huge.length <= 60 && huge.endsWith('…'), huge);
  assert.equal(pageTitle({ name: 'Hall: east – west', place: 'Hall', kind: 'space', brand }), 'Hall, east, west · Sites');
  assert.equal(kindLine('hunt', 'Save the Scrolls', 'The Byzantine Church, Petra, Jordan', true), 'A scavenger hunt in the Byzantine Church, Petra, Jordan');
  assert.equal(kindLine('tour', 'The Royal Tombs', 'The Royal Tombs, Petra, Jordan', true), 'A guided tour');
  assert.equal(kindLine('space', 'Hall', 'Hall', false), undefined);
});

test('descriptions come from the first words a visitor reads, whole sentences up to 155 characters', () => {
  const words = 'The largest pyramid at Giza was built for the pharaoh Khufu. When completed, it was 481 feet tall – the tallest human-made structure on earth for almost 3,800 years.';
  const description = pageDescription([[], [words]], 'Fallback.');
  assert.equal(description, 'The largest pyramid at Giza was built for the pharaoh Khufu.', 'the sentence that does not fit is left out');
  assert.equal(pageDescription([['Welcome.', 'You are standing on blocks of the pyramid, looking out over the plateau and the city below.']], 'x'),
    'Welcome. You are standing on blocks of the pyramid, looking out over the plateau and the city below.', 'a stop that says little takes the next one too');
  assert.equal(pageDescription([[], []], 'Walk through the hall in 3D, right in your browser.'), 'Walk through the hall in 3D, right in your browser.');
  const unbroken = fitText('word '.repeat(60));
  assert.ok(unbroken.length <= 155 && unbroken.endsWith('word…'), unbroken);
  for (const text of [description, unbroken]) assert.doesNotMatch(text, plainRules);
});

test('older tours\' HTML reads as the paragraphs a visitor sees, without scripts or tags', () => {
  assert.deepEqual(htmlParagraphs('<p>Behind you is <a href="https://example.org">Giza</a>.</p><p>Ancient&nbsp;times &amp; now&#8217;s &rsquo;view&#x2019;</p><script>alert(1)</script><style>p{}</style>'),
    ['Behind you is Giza.', 'Ancient times & now’s ’view’']);
  assert.deepEqual(htmlParagraphs('Line one<br>line two'), ['Line one\nline two'.replace(/\s+/g, ' ')]);
  assert.deepEqual(htmlParagraphs(''), []);
});

const capture = (tour) => ({
  space: { id: 'hall', title: 'Grand Hall', type: 'spaces', space_data: { nodes: [{ uuid: 'n1', image: 'x.jpg' }], geo: { lat: 29.9792, lon: 31.1342, heading: 0 } } },
  tour: { id: 't', title: 'Inside the Grand Hall', description: '<p>An opening line.</p>', tour_data: tour },
  ui: {}
});
const legacyTour = {
  mode: 'guided', continueTo: { url: '/s/abcdefabcdef/the-next-room', label: 'Continue to the next room' },
  objects: [{ id: 'portal', name: 'Next room', link: '/s/abcdefabcdef/the-next-room', source: { kind: 'model', url: 'https://example.org/p.glb' }, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    { id: 'door', name: 'Garden door', label: 'Go to the garden', link: 'https://example.org/garden', source: { kind: 'shape', shape: 'orb' }, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    { id: 'vase', name: 'Vase', source: { kind: 'shape', shape: 'orb' }, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    { id: 'bad', name: 'Bad', link: 'javascript:alert(1)', source: { kind: 'shape', shape: 'orb' }, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }],
  spaces: [{ id: 'hall', tourpoints: [
    { id: 's1', nodeUUID: 'n1', text: '', files: [], models: ['mesh'], rotation: { azimuth: 0, polar: 0 } },
    { id: 's2', nodeUUID: 'n1', title: 'Hidden title', text: '<p>The hall was built in 1902.</p>', secondaryText: '<p>More below.</p>', files: [{ url: 'https://example.org/a.jpg' }] }
  ] }]
};

test('the stops are the text the viewer shows, kept small between requests', () => {
  const source = searchSource(capture(legacyTour));
  assert.ok(JSON.stringify(source).length < 2000, 'only the text parts are kept');
  assert.equal(source.space.space_data.nodes, undefined, 'panoramas and models are left out');
  const text = searchText(source);
  assert.deepEqual(text.stops, [{ title: undefined, text: ['An opening line.'] }, { title: undefined, text: ['The hall was built in 1902.', 'More below.'] }],
    'an empty first stop shows the tour\'s opening words, and HTML stops show no title, as in the viewer');
  assert.deepEqual(text.links, [{ url: '/s/abcdefabcdef/the-next-room', label: 'Continue to the next room' }, { url: 'https://example.org/garden', label: 'Go to the garden' }],
    'onward links once each, never a script');
  assert.deepEqual(text.coordinates, { lat: 29.9792, lon: 31.1342 });
  assert.equal(text.spaceTitle, 'Grand Hall', 'the place keeps its own name beside the tour\'s');
  assert.equal(text.guided, true);
});

test('a space\'s own hunt and a customer\'s tour stand in for the stops, and a scan to explore has none', () => {
  const hunt = { version: 1, kind: 'hunt', title: 'Find the lamps', finale: 'All found.\n\nWell done.', objects: [], effects: [],
    stops: [{ id: 'c1', title: 'Under the window', text: 'Look where the light comes in.\n\nIt is brass.', view: { nodeId: 'n1', rotation: { azimuth: 0, polar: 0 } }, objects: [], effects: [],
      find: { objectId: 'lamp', hint: 'Look up.', found: 'Lit.' } }] };
  const source = searchSource(capture(legacyTour));
  const own = searchText(source, { experience: hunt });
  assert.deepEqual(own.stops, [{ title: 'Under the window', text: ['Look where the light comes in.', 'It is brass.'] }], 'hints and found notes stay hidden until played');
  assert.deepEqual(own.finale, ['All found.', 'Well done.']);
  assert.equal(own.kind, 'hunt');
  const standalone = searchText(source, { experience: { ...hunt, stops: [] }, standalone: true });
  assert.deepEqual([standalone.stops, standalone.guided, standalone.links], [[], false, []], 'an empty tour of its own shows no stops and no onward links');
  assert.deepEqual(searchText(searchSource(capture({ mode: 'explore', spaces: [{ id: 'hall', tourpoints: [{ id: 'a', nodeUUID: 'n1', text: 'Scan 1' }] }] }))).stops, []);
});

test('structured data is a page about a place, published by the site, safe inside a script element', () => {
  const json = pageJsonLd({ url: 'https://app.example/s/abcdefabcdef/hall', name: 'Hall </script>', description: 'A hall.', image: 'https://cdn.example/p.jpg',
    place: 'Grand Hall', location: 'Giza, Egypt', coordinates: { lat: 1, lon: 2 }, created: '2026-01-01',
    publisher: { id: 'https://home.example/#organization', name: 'Sites', url: 'https://home.example' } });
  assert.ok(!json.includes('</script>'));
  const data = JSON.parse(json);
  assert.equal(data['@type'], 'WebPage');
  assert.deepEqual(data.about, { '@type': 'Place', name: 'Grand Hall', address: 'Giza, Egypt', geo: { '@type': 'GeoCoordinates', latitude: 1, longitude: 2 } });
  assert.deepEqual(data.publisher, { '@type': 'Organization', '@id': 'https://home.example/#organization', name: 'Sites', url: 'https://home.example' });
  assert.equal(data.name, 'Hall </script>');
});
