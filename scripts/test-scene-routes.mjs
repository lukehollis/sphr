#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const origin = process.argv[2] || "http://localhost:3002";
const { spaces } = JSON.parse(await readFile("public/datasets/matterport/index.json", "utf8"));
assert.ok(spaces.length, "Import a real capture before running route integration checks");
const get = (path) => fetch(new URL(path, origin), { redirect: "manual" });
const home = await get("/");
assert.equal(home.status, 200);
const html = await home.text();
assert.match(html, /Search spaces/);
assert.doesNotMatch(html, /<canvas/);
for (const space of spaces) {
  assert.ok(html.includes(space.scenePath), `Missing scene card: ${space.title}`);
  const page = await get(space.scenePath);
  assert.equal(page.status, 200, space.scenePath);
  const body = await page.text();
  assert.ok(body.includes(space.bootstrapUrl), "Correct bootstrap is wired to the scene route");
  assert.ok(body.includes('property="og:image"'), "Scene thumbnail is available to sharing previews");
  for (const alias of [`/s/${space.sceneId}`, `/s/${space.sceneId}/an-old-title`]) {
    const redirect = await get(alias);
    assert.equal(redirect.status, 307, alias);
    assert.equal(redirect.headers.get("location"), space.scenePath);
  }
  for (const asset of [space.thumbnail, space.bootstrapUrl]) {
    const response = await get(asset);
    assert.equal(response.status, 200, asset);
    await response.arrayBuffer();
  }
}
const missing = await get("/s/ffffffffffff/unknown-space");
assert.equal(missing.status, 404);
assert.match(await missing.text(), /Browse all spaces/);
const library = await get("/library");
assert.equal(library.status, 307);
assert.equal(library.headers.get("location"), "/");
for (const legacy of ["/?demo=garden", `/?config=${encodeURIComponent(spaces[0].bootstrapUrl)}`]) {
  const response = await get(legacy);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<canvas/);
}
console.log(`Passed: ${spaces.length} real scene routes, ID/old-title redirects, thumbnails/configs, 404, collection and legacy URLs.`);
