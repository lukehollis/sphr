import test from 'node:test';
import assert from 'node:assert/strict';
import { withAssetBase } from '../lib/hosted-assets.ts';
import { parseSceneCatalog } from '../lib/scene-catalog-data.ts';
import { mediaImageUrl, mediaVideoUrl } from '../lib/media.ts';

const base='https://static.mused.com/sphr';
const entry={sceneId:'aaaaaaaaaaaa',titleSlug:'example-space',scenePath:'/s/aaaaaaaaaaaa/example-space',
  title:'Example Space',slug:'example-space',nodeCount:3,createdAt:'2026-01-01',
  bootstrapUrl:'/datasets/matterport/example-space/bootstrap.json',thumbnail:'/datasets/matterport/example-space/preview.jpg'};
const parse=(entries, root='')=>parseSceneCatalog(JSON.stringify({spaces:entries}), root);

test('local and remote catalogs preserve stable scene links and resolve their asset roots',()=>{
  assert.equal(parse([entry])[0].bootstrapUrl,entry.bootstrapUrl);
  assert.equal(parse([entry],base)[0].bootstrapUrl,base+entry.bootstrapUrl);
  const published={...entry,bootstrapUrl:base+'/scenes/'+entry.sceneId+'/0123456789abcdef/bootstrap.json',
    thumbnail:base+'/scenes/'+entry.sceneId+'/0123456789abcdef/preview.jpg'};
  assert.deepEqual(parse([published],base)[0],published);
});
test('reject foreign origins, wrong scene IDs, path escapes, and duplicate IDs',()=>{
  const config=base+'/scenes/'+entry.sceneId+'/0123456789abcdef/bootstrap.json';
  for(const url of [config.replace('static.mused.com','other.example'),config.replace(entry.sceneId,'ffffffffffff'),
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
test('static tour media uses the .com bucket and local previews do not require IIIF',()=>{
  assert.equal(mediaVideoUrl({filename:'tour/example.mp4'}),'https://static.mused.com/tour/example.mp4');
  assert.equal(mediaImageUrl({url:'/demo/garden_scene_splats_tour.jpg'}),'/demo/garden_scene_splats_tour.jpg');
  assert.equal(mediaImageUrl({url:'https://images.example/photo.jpg'}),'https://images.example/photo.jpg');
});
