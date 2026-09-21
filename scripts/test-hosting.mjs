import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { withAssetBase } from '../lib/hosted-assets.ts';
import { parseSceneCatalog } from '../lib/scene-catalog-data.ts';
import { mediaImageUrl, mediaVideoUrl } from '../lib/media.ts';

const base='https://static.example.com/sphr';
const entry={sceneId:'aaaaaaaaaaaa',titleSlug:'example-space',scenePath:'/s/aaaaaaaaaaaa/example-space',
  title:'Example Space',slug:'example-space',nodeCount:3,createdAt:'2026-01-01',
  bootstrapUrl:'/datasets/matterport/example-space/bootstrap.json',thumbnail:'/datasets/matterport/example-space/preview.jpg'};
const parse=(entries, root='')=>parseSceneCatalog(JSON.stringify({spaces:entries}), root);

test('catalog preserves explicit guided availability independently of capture source', () => {
  assert.equal(parse([{...entry, hasGuidedTour:true}])[0].hasGuidedTour, true);
  assert.equal(parse([{...entry, hasGuidedTour:false}])[0].hasGuidedTour, false);
  assert.throws(()=>parse([{...entry,hasGuidedTour:'yes'}]), /guided tour availability/);
});

test('local and remote catalogs preserve stable scene links and resolve their asset roots',()=>{
  assert.equal(parse([entry])[0].bootstrapUrl,entry.bootstrapUrl);
  assert.equal(parse([entry],base)[0].bootstrapUrl,base+entry.bootstrapUrl);
  const published={...entry,bootstrapUrl:base+'/scenes/'+entry.sceneId+'/0123456789abcdef/bootstrap.json',
    thumbnail:base+'/scenes/'+entry.sceneId+'/0123456789abcdef/preview.jpg'};
  assert.deepEqual(parse([published],base)[0],published);
});
test('reject foreign origins, wrong scene IDs, path escapes, and duplicate IDs',()=>{
  const config=base+'/scenes/'+entry.sceneId+'/0123456789abcdef/bootstrap.json';
  for(const url of [config.replace('static.example.com','other.example'),config.replace(entry.sceneId,'ffffffffffff'),
    config.replace('/sphr/','/other/'),config+'?redirect=1','//other.example/bootstrap.json']){
    assert.throws(()=>parse([{...entry,bootstrapUrl:url}],base));
  }
  assert.throws(()=>parse([entry,entry],base));
  assert.throws(()=>parse([{...entry,scenePath:'/s/a/wrong'}],base));
});
test('rebase all nested runtime assets without mutating source data or camera calibration',()=>{
  const input={space:{mesh:'/datasets/matterport/example-space/mesh/example-space-50k.glb',
    nodes:[{faces:['/datasets/matterport/example-space/faces/scan-000/face0.jpg'],position:[1,2,3]}],
    splats:[{url:'/demo/garden_demo.spark.splat'}]},tour:{text:'A tour',audio:'https://audio.example/test.mp3'}};
  const output=withAssetBase(input,base);
  assert.equal(output.space.mesh,base+input.space.mesh);
  assert.equal(output.space.nodes[0].faces[0],base+input.space.nodes[0].faces[0]);
  assert.equal(output.space.splats[0].url,base+input.space.splats[0].url);
  assert.deepEqual(output.space.nodes[0].position,[1,2,3]);
  assert.deepEqual(output.tour,input.tour);
  assert.ok(input.space.mesh.startsWith('/datasets/'));
  assert.deepEqual(withAssetBase(input,''),input);
});
test('unconfigured media stays on the local host and explicit asset URLs are preserved',()=>{
  assert.equal(mediaVideoUrl({filename:'tour/example.mp4'}),'/tour/example.mp4');
  assert.equal(mediaImageUrl({url:'/demo/garden_scene_splats_tour.jpg'}),'/demo/garden_scene_splats_tour.jpg');
  assert.equal(mediaImageUrl({url:'https://images.example/photo.jpg'}),'https://images.example/photo.jpg');
});

function isolatedModule(module, expression, overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(NEXT_PUBLIC_)?SPHR_|^VERCEL$/.test(key)) delete env[key];
  const source = `const mod = await import(${JSON.stringify(new URL(module, import.meta.url).href)}); console.log(JSON.stringify(${expression}));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { env: { ...env, ...overrides }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('hosted platforms do not implicitly select an operator catalog or asset host', () => {
  const env = isolatedModule('../next.config.mjs', 'mod.default.env', { VERCEL: '1' });
  assert.equal(env.SPHR_ASSET_BASE_URL, '');
  assert.equal(env.SPHR_CATALOG_URL, '');
  assert.equal(env.SPHR_PUBLIC_URL, 'http://localhost:3002');
  const configured = isolatedModule('../next.config.mjs', 'mod.default.env', {
    SPHR_ASSET_BASE_URL: 'https://assets.example.com/scenes/', SPHR_PUBLIC_URL: 'https://viewer.example.com'
  });
  assert.equal(configured.SPHR_CATALOG_URL, 'https://assets.example.com/scenes/datasets/matterport/index.json');
  assert.equal(configured.NEXT_PUBLIC_SPHR_ASSET_BASE_URL, 'https://assets.example.com/scenes');
  assert.equal(configured.SPHR_PUBLIC_URL, 'https://viewer.example.com');
});

test('media origins can be configured independently without changing explicit URLs', () => {
  const result = isolatedModule('../lib/media.ts', `[
    mod.mediaVideoUrl({ filename: 'audio/clip.mp4' }),
    mod.iiifImageUrl('photos/a.jpg', '600,'),
    mod.iiifConfigUrl({ url: 'https://other.example.com/iiif/file.jpg' }),
    mod.iiifInfoUrl({ image: 'photos/a.jpg' })
  ]`, { NEXT_PUBLIC_SPHR_MEDIA_BASE_URL: 'https://assets.example.com', NEXT_PUBLIC_SPHR_IIIF_BASE_URL: 'https://images.example.com' });
  assert.deepEqual(result, ['https://assets.example.com/audio/clip.mp4',
    'https://images.example.com/photos/a.jpg/full/600,/0/default.jpg',
    'https://other.example.com/iiif/file.jpg', 'https://images.example.com/photos/a.jpg/info.json']);
  assert.equal(isolatedModule('../lib/media.ts', "mod.iiifConfigUrl({url:'https://images.example.com/iiif/file.jpg'})"),
    'https://images.example.com/iiif/file.jpg');
});
