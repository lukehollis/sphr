// Run only against a local access-controlled server with its own disposable state.
// SPHR_TEST_USERNAME and SPHR_TEST_PASSWORD supply the initialized local account.
import assert from 'node:assert/strict';
const base = process.argv[2] || 'http://127.0.0.1:3002';
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname), 'This test changes visibility; use a local server.');
const username = process.env.SPHR_TEST_USERNAME;
const password = process.env.SPHR_TEST_PASSWORD;
assert.ok(username && password, 'Configure the local test account.');
const catalogUrl = process.env.SPHR_TEST_CATALOG_URL || new URL('/datasets/matterport/index.json', base).href;
const catalog = await (await fetch(catalogUrl)).json();
assert.ok(catalog.spaces.length);
const scene = catalog.spaces[0];
const path = scene.scenePath;
let cookie;
async function call(route, options = {}) {
  return fetch(base + route, { redirect: 'manual', ...options, headers: {
    Origin: base, 'Content-Type': 'application/json', ...(options.admin ? { Cookie: cookie } : {}), ...options.headers
  } });
}
async function visibility(value) {
  const response = await call(`/api/admin/scenes/${scene.sceneId}`, { method: 'PATCH', admin: true, body: JSON.stringify({ public: value }) });
  assert.equal(response.status, 200);
}
async function expectPrivateIndex(options = {}) {
  const response = await call('/', options);
  const body = await response.text();
  if (options.headers?.RSC === '1') {
    assert.match(body, /NEXT_REDIRECT;replace;\/admin\/login\?next=%2F;307;/, 'RSC sends a redirect instead of listings');
  } else {
    assert.equal(response.status, 307, 'the collection requires an admin session');
    assert.equal(response.headers.get('location'), '/admin/login?next=%2F');
  }
  assert.match(response.headers.get('cache-control'), /no-store|no-cache/);
  assert.ok(!body.includes(scene.title), 'no scene titles in anonymous HTML or RSC');
  assert.ok(!body.includes(scene.sceneId), 'no scene IDs in anonymous HTML or RSC');
}
await expectPrivateIndex();
await expectPrivateIndex({ headers: { Cookie: '__Host-sphr-admin=invalid; sphr-admin=invalid' } });
await expectPrivateIndex({ headers: { RSC: '1' } });
assert.equal((await call('/admin')).status, 307);
assert.equal((await call('/api/admin/scenes/' + scene.sceneId, { method: 'PATCH', body: JSON.stringify({ public: true }) })).status, 401);
assert.equal((await call('/api/admin/login', { method: 'POST', headers: { Origin: 'https://invalid.example' }, body: JSON.stringify({ username, password }) })).status, 400);
const login = await call('/api/admin/login', { method: 'POST', body: JSON.stringify({ username, password }) });
assert.equal(login.status, 200);
const setCookie = login.headers.get('set-cookie');
assert.match(setCookie, /HttpOnly/i);
assert.match(setCookie, /SameSite=lax/i);
cookie = setCookie.split(';')[0];
try {
  await visibility(false);
  const closed = await call(path);
  assert.equal(closed.status, 307);
  assert.ok(closed.headers.get('location').startsWith('/admin/login?next='));
  await expectPrivateIndex();
  assert.equal((await call(path, { admin: true })).status, 200);
  const adminHome = await (await call('/', { admin: true })).text();
  assert.ok(adminHome.includes(scene.title));
  assert.match((await call('/', { admin: true })).headers.get('cache-control'), /no-store|no-cache/);
  assert.equal((await call('/admin/login?next=%2F', { admin: true })).headers.get('location'), '/');
  assert.equal((await call('/admin/login?next=https%3A%2F%2Finvalid.example', { admin: true })).headers.get('location'), '/admin');
  assert.equal((await call('/admin/login?next=%2F%2Finvalid.example', { admin: true })).headers.get('location'), '/admin');
  assert.equal((await call('/?config=' + encodeURIComponent(scene.bootstrapUrl))).status, 307);
  assert.equal((await call('/api/admin/scenes/' + scene.sceneId, { method: 'PATCH', admin: true, headers: { Origin: 'https://invalid.example' }, body: JSON.stringify({ public: true }) })).status, 400);
  await visibility(true);
  assert.equal((await call(path)).status, 200);
  await expectPrivateIndex();
  await expectPrivateIndex({ headers: { RSC: '1' } });
  assert.equal((await call('/?demo=garden')).status, 200, 'direct demo links remain available');
  assert.equal((await call(`/s/${scene.sceneId}/old-title`)).headers.get('location'), path);
  await visibility(false);
  assert.equal((await call(path)).status, 307);
  assert.equal((await fetch(new URL(scene.thumbnail, base))).status, 200, 'public bucket assets remain available');
  assert.equal((await call('/admin', { admin: true })).status, 200);
  assert.equal((await call('/api/admin/logout', { method: 'POST', admin: true })).status, 200);
  await expectPrivateIndex({ admin: true });
  assert.equal((await call('/api/admin/scenes/' + scene.sceneId, { method: 'PATCH', admin: true, body: JSON.stringify({ public: true }) })).status, 401, 'logout revokes server session');
} finally {
  // Local state stays private even if an assertion fails mid-test.
  await call(`/api/admin/scenes/${scene.sceneId}`, { method: 'PATCH', admin: true, body: JSON.stringify({ public: false }) });
}
console.log('Passed: admin-only index (HTML/RSC), public/private viewer links, safe login return paths, admin authorization, origin checks, cookies, logout, and unchanged public assets.');
