import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SPHR_LIGHT_BASE_URL = 'https://light.test/sphr/light';
const { sceneLightCopies, translatedFrom } = await import('../lib/server/light.ts');

// Catalog entries as published: the English Great Pyramid tour, two of its translations, and spaces that only look related.
const khufu = { sceneId: '619ad80511a1', slug: 'guided-khufu', nodeCount: 145, hasGuidedTour: true };
const es = { sceneId: 'cd5b6e62be9d', slug: 'guided-khufu-es', nodeCount: 145, hasGuidedTour: true };
const zh = { sceneId: '9fd0739637ed', slug: 'guided-khufu-zh-hans', nodeCount: 145, hasGuidedTour: true };
const luxor = { sceneId: '8f0a085fcfad', slug: 'guided-luxortemple', nodeCount: 675, hasGuidedTour: true };
const luxorArt = { sceneId: 'aaaaaaaaaaa1', slug: 'guided-luxortemple-art', nodeCount: 675, hasGuidedTour: true };
const space39 = { sceneId: 'f5e8ba5b9dd4', slug: 'space-39', nodeCount: 145, hasGuidedTour: false };
const catalog = [khufu, es, zh, luxor, luxorArt, space39];

const index = (sceneId) => ({ version: 1, faces: { template: `https://light.test/sphr/light/${sceneId}/v1/faces/{size}/{uuid}/face{face}.jpg`, sizes: [512, 1024], nodes: ['scan-000'] } });

/** Answers light lookups from a set of published indexes, and records what was asked for. */
function published(...sceneIds) {
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    const id = String(url).match(/\/light\/([a-f0-9]{12})\/index\.json$/)?.[1];
    return sceneIds.includes(id) ? new Response(JSON.stringify(index(id))) : new Response('Not found', { status: 404 });
  };
  return asked;
}

test('a translated guided tour is matched to the English tour it was copied from', () => {
  assert.equal(translatedFrom(es, catalog), khufu);
  assert.equal(translatedFrom(zh, catalog), khufu);
});

test('only a translation borrows: the English tour, other spaces and look-alike slugs have no source', () => {
  assert.equal(translatedFrom(khufu, catalog), null);
  assert.equal(translatedFrom(space39, catalog), null);
  assert.equal(translatedFrom(luxorArt, catalog), null, 'a word after the slug is not a language tag');
  assert.equal(translatedFrom({ ...es, slug: 'guided-giza-es' }, catalog), null, 'no English tour by that slug');
  assert.equal(translatedFrom({ ...es, nodeCount: 144 }, catalog), null, 'different locations');
  assert.equal(translatedFrom({ ...es, hasGuidedTour: false }, catalog), null);
  assert.equal(translatedFrom({ sceneId: 'bbbbbbbbbbb1', slug: 'customer-guided-khufu-es', nodeCount: 145, hasGuidedTour: true }, catalog), null);
});

test('a translation with no light copies of its own gets the English tour\'s', async () => {
  const asked = published(khufu.sceneId);
  const copies = await sceneLightCopies(es, catalog);
  assert.equal(copies?.faces?.template, index(khufu.sceneId).faces.template);
  assert.deepEqual(asked.sort(), [`https://light.test/sphr/light/${es.sceneId}/index.json`, `https://light.test/sphr/light/${khufu.sceneId}/index.json`].sort());
});

test('copies made for the translation itself come first', async () => {
  published(zh.sceneId, khufu.sceneId);
  assert.equal((await sceneLightCopies(zh, catalog))?.faces?.template, index(zh.sceneId).faces.template);
});

test('a space that is no translation asks only for its own copies', async () => {
  const asked = published(khufu.sceneId);
  assert.equal(await sceneLightCopies(space39, catalog), null);
  assert.deepEqual(asked, [`https://light.test/sphr/light/${space39.sceneId}/index.json`]);
});

test('with neither tour copied the translation keeps the full-size files', async () => {
  const ramesses = { sceneId: '8ad9abbe533a', slug: 'guided-ramessesii', nodeCount: 133, hasGuidedTour: true };
  const ramessesEs = { sceneId: '6a71ed970126', slug: 'guided-ramessesii-es', nodeCount: 133, hasGuidedTour: true };
  published();
  assert.equal(await sceneLightCopies(ramessesEs, [ramesses, ramessesEs]), null);
});
