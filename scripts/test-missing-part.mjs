// The <head> script that catches parts of the page that never arrive (lib/missing-part.ts), run in a small fake browser.
//   node --test scripts/test-missing-part.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { cameFrom, missingPartScript, reloadedAt } from '../lib/missing-part.ts';

const mused = 'https://mused.com/guided/266/go-inside-the-great-pyramid-of-giza/';

class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.style = {}; this.children = []; this.attributes = {}; this.textContent = ''; }
  setAttribute(name, value) { this.attributes[name] = value; }
  appendChild(child) { this.children.push(child); return child; }
}

/** One page load: the script runs, then `fail` fires the error a part of the page raises. */
function page({ referrer = '', framed = true, storage = new Map(), readyState = 'interactive', fetch, instantTimers = false } = {}) {
  const listeners = {}, beacons = [], messages = [], body = new Element('body');
  let reloads = 0;
  const everything = () => { const found = []; const walk = node => { found.push(node); node.children.forEach(walk); }; walk(body); return found; };
  const window = {
    location: { origin: 'https://app.spacery.dev', host: 'app.spacery.dev', pathname: '/s/619ad80511a1/tour', href: 'https://app.spacery.dev/s/619ad80511a1/tour', reload() { reloads++; } },
    document: { referrer, readyState, body, createElement: tag => new Element(tag), getElementById: id => everything().find(node => node.id === id) ?? null },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    navigator: { sendBeacon: (url, data) => { beacons.push({ url, ...JSON.parse(data) }); return true; } },
    fetch: fetch ?? (async () => ({ status: 200, headers: new Map([['content-type', 'text/javascript'], ['cf-ray', 'x']]), text: async () => 'ok' })),
    addEventListener: (type, listener) => { (listeners[type] ??= []).push(listener); },
    setTimeout: instantTimers ? listener => listener() : setTimeout, URL,
    // Messages are copied out of the page's realm, as postMessage would.
    parent: { postMessage: (message, origin) => messages.push({ message: JSON.parse(JSON.stringify(message)), origin }) },
  };
  Object.assign(window, { window, self: window, top: framed ? {} : window });
  vm.createContext(window);
  vm.runInContext(missingPartScript(true), window);
  const fail = (src, tagName = 'SCRIPT') => listeners.error.forEach(listener => listener({ target: { tagName, src: `https://app.spacery.dev${src}` } }));
  return { fail, beacons, messages, storage, reloads: () => reloads, notice: () => window.document.getElementById('sphr-missing-part') };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const props = beacon => beacon.events[0].props;

test('a part that fails once reloads the page and keeps where the visitor came from', () => {
  const first = page({ referrer: mused });
  first.fail('/_next/static/chunks/core.js?v=1');
  assert.equal(first.reloads(), 1);
  assert.deepEqual(props(first.beacons[0]), { kind: 'load', message: 'ChunkLoadError: Failed to load /_next/static/chunks/core.js', source: 'reloaded the page' });
  assert.equal(first.beacons[0].framed, true, 'a framed page asks for the cookie that works in a frame');
  assert.equal(first.storage.get(cameFrom), mused);
  assert.equal(first.notice(), null);
  assert.deepEqual(first.messages, []);
});

test('a part still refused after the reload sends mused visitors to the classic tour and reports what the network answered', async () => {
  const storage = new Map([[reloadedAt, String(Date.now())], [cameFrom, mused]]);
  const blocked = async () => ({ status: 403, headers: new Map([['content-type', 'text/html'], ['server', 'Zscaler/6.2']]), text: async () => '<html>\n  Website blocked by policy </html>' });
  const again = page({ storage, fetch: blocked });
  again.fail('/_next/static/chunks/core.js');
  assert.equal(again.reloads(), 0, 'no second reload');
  assert.deepEqual(again.messages, [{ message: { type: 'spacery:failed', reason: 'missing-part' }, origin: '*' }], 'the framing page is told');
  const go = again.notice().children[0].children[2];
  assert.deepEqual([go.href, go.target, go.textContent], [`${mused}?version=classic`, '_top', 'Open the classic tour']);
  await settle();
  assert.equal(props(again.beacons[0]).source, 'still failing after a reload');
  assert.equal(props(again.beacons[0]).detail, 'HTTP 403 text/html, not from Cloudflare, server Zscaler/6.2: <html> Website blocked by policy </html>');
  assert.equal(again.beacons[0].referrer, mused, 'the reloaded page still counts as a visit from mused.com');
});

test('elsewhere the notice offers another try, and a network that never answers is reported too', async () => {
  const again = page({ framed: false, storage: new Map([[reloadedAt, String(Date.now())]]), fetch: () => new Promise(() => {}), instantTimers: true });
  again.fail('/_next/static/css/app.css', 'LINK');
  assert.equal(again.notice(), null, 'a link element that is not a stylesheet is not a part of the page');
  const sheet = page({ framed: false, storage: new Map([[reloadedAt, String(Date.now())]]), fetch: () => new Promise(() => {}), instantTimers: true });
  sheet.fail('/_next/static/chunks/core.js');
  const go = sheet.notice().children[0].children[2];
  assert.deepEqual([go.href, go.target, go.textContent], ['https://app.spacery.dev/s/619ad80511a1/tour', undefined, 'Try again']);
  assert.deepEqual(sheet.messages, [], 'a page that is not framed has no one to tell');
  await settle();
  assert.equal(props(sheet.beacons[0]).detail, 'no answer in 8 s');
});

test('other failures are left alone: after the page loaded, other files, and anything after the first', () => {
  const loaded = page({ readyState: 'complete' });
  loaded.fail('/_next/static/chunks/core.js');
  const image = page();
  image.fail('/_next/static/media/photo.jpg', 'IMG');
  const elsewhere = page();
  elsewhere.fail('/scripts/widget.js');
  for (const visit of [loaded, image, elsewhere]) assert.deepEqual([visit.reloads(), visit.beacons.length, visit.notice()], [0, 0, null]);
  const twice = page();
  twice.fail('/_next/static/chunks/core.js');
  twice.fail('/_next/static/chunks/other.js');
  assert.deepEqual([twice.reloads(), twice.beacons.length], [1, 1], 'only the first failure counts');
});
