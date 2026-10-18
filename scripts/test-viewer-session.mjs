import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Exercise the real session lifecycle. Only the DOM and GPU renderer are replaced;
// renderer initialization stays pending until each test completes or fails it.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@/')) {
      const path = specifier.slice(2), json = path.endsWith('.json');
      return next(new URL(`../${path}${json ? '' : '.ts'}`, import.meta.url).href,
        json ? { ...context, importAttributes: { type: 'json' } } : context);
    }
    if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) return next(specifier + '.ts', context);
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('/lib/three/SphrRuntime.ts')) return { format: 'module', shortCircuit: true, source: `
      export class SphrRuntime {
        constructor(canvas, bootstrap, callbacks) {
          this.canvas = canvas; this.callbacks = callbacks;
          this.state = { activePointIndex: 0, activeSpaceIndex: 0, viewMode: 'FPV', guided: true, muted: false, showText: true, navigating: false,
            loading: { ready: false, label: 'Loading', progress: 0 } };
          this.loaded = new Promise((resolve, reject) => { this.complete = resolve; this.fail = reject; });
          globalThis.renderers.push(this);
        }
        async init(index = 0) { this.state.activePointIndex = index; this.report(.1); await this.loaded; this.state.loading = { ready: true, progress: 1, label: 'Ready' }; this.callbacks.onState(this.getState()); }
        report(progress) { this.state.loading.progress = progress; this.callbacks.onState(this.getState()); }
        start(guided) { this.state.guided = guided; this.callbacks.onState(this.getState()); }
        getState() { return structuredClone(this.state); }
        toggleMute() { this.state.muted = !this.state.muted; this.callbacks.onState(this.getState()); }
        toggleText() { this.state.showText = !this.state.showText; this.callbacks.onState(this.getState()); }
        setViewInset() {}
        setXrPanel(panel) { this.xrPanel = panel; }
        async enterXr(handoff) { this.xr = handoff ?? { session: 'headset', yaw: 0 }; }
        releaseXr() { const handoff = this.xr ?? null; this.xr = null; return handoff; }
        dispose() { this.disposed = true; }
      }
    ` };
    return next(url, url.endsWith('.json') ? { ...context, importAttributes: { type: 'json' } } : context);
  }
});
const { ViewerSession } = await import('../lib/viewer/ViewerSession.ts');
const source = {
  space: { id: 'gallery', title: 'Gallery', type: 'spaces', space_data: { nodes: [{ uuid: 'entrance' }] } },
  tour: { tour_data: { mode: 'guided', sceneGraph: [{ id: 'statue', type: 'model', file: '/statue.glb' }], spaces: [
    { id: 'gallery', tourpoints: [{ nodeUUID: 'entrance', text: 'Gallery' }, { targetType: 'MODEL', models: ['statue'], text: 'Statue', viewMode: 'ORBIT' }] }
  ] } }
};
function setup(t) {
  const priorDocument = globalThis.document;
  const priorRenderers = globalThis.renderers;
  const priorContexts = globalThis.contexts;
  // Each canvas's WebGL context, in the order canvases ask: 'ready' unless a test queues 'lost' or 'none'.
  const context = kind => kind === 'none' ? null : { VERTEX_SHADER: 1, HIGH_FLOAT: 2, lost: kind === 'lost',
    isContextLost() { return this.lost; }, getShaderPrecisionFormat() { return this.lost ? null : { precision: 23 }; } };
  const element = () => ({ dataset: {}, style: {}, children: [], listeners: {}, append(child) { this.children.push(child); }, setAttribute() {}, remove() { this.removed = true; },
    addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); },
    removeEventListener(type, listener) { this.listeners[type] = (this.listeners[type] ?? []).filter(item => item !== listener); },
    getContext() { if (!('gl' in this)) this.gl = context(globalThis.contexts.shift() ?? 'ready'); return this.gl; } });
  globalThis.document = { createElement: element, hidden: false, addEventListener() {}, removeEventListener() {} };
  globalThis.renderers = [];
  globalThis.contexts = [];
  const container = element(), states = [], restored = [];
  const session = new ViewerSession(container, structuredClone(source), { onState: state => states.push(structuredClone(state)), onContextRestored: details => restored.push(details) });
  t.after(() => { session.dispose(); globalThis.document = priorDocument; globalThis.renderers = priorRenderers; globalThis.contexts = priorContexts; });
  return { session, container, states, restored };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
async function open(session) {
  const pending = session.init();
  renderers[0].complete();
  await pending;
}

test('initial entry waits for its scene, then opens automatically', async t => {
  const { session, container } = setup(t);
  const opening = session.init();
  assert.equal(session.getState().loading.ready, false);
  assert.equal(Boolean(session.getState().loading.busy), false);
  assert.equal(container.children[0].style.opacity, '0');
  renderers[0].complete(); await opening;
  assert.equal(session.getState().loading.ready, true);
  assert.equal(session.getState().loading.busy, undefined);
  assert.equal(container.children[0].style.opacity, '1');
});

test('a delayed model keeps the outgoing view and caption until the incoming scene is ready', async t => {
  const { session, container, states } = setup(t);
  await open(session);
  const outgoing = renderers[0];
  const transition = session.goTo(0, 1);
  renderers[1].report(.7);
  assert.equal(session.getState().loading.ready, true);
  assert.equal(session.getState().loading.busy, true);
  assert.equal(session.getState().loading.progress, .7);
  assert.equal(session.getState().activePointIndex, 0);
  assert.equal(session.getState().navigating, true);
  assert.equal(container.children[0].style.opacity, '1');
  assert.equal(container.children[1].style.opacity, '0');
  assert.equal(outgoing.disposed, undefined);
  await session.goTo(0, 1);
  assert.equal(renderers.length, 2, 'repeated Next cannot create duplicate renderers');
  session.toggleMute();
  renderers[1].complete(); await transition;
  assert.equal(session.getState().activePointIndex, 1);
  assert.equal(session.getState().muted, true);
  assert.equal(session.getState().loading.busy, undefined);
  assert.equal(session.getState().navigating, false);
  assert.equal(container.children[1].style.opacity, '1');
  assert.equal(outgoing.disposed, undefined, 'outgoing canvas stays under the short incoming fade');
  assert.ok(states.every(state => state.loading.ready || state.activePointIndex === 0));
  session.dispose();
  assert.equal(outgoing.disposed, true, 'disposal also releases canvases still fading out');
  assert.equal(renderers[1].disposed, true);
});

test('a headset goes on into the next space with its turn and the tour panel', async t => {
  const { session } = setup(t);
  await open(session);
  await session.enterXr();
  renderers[0].xr.yaw = 1.2;
  const panel = { eyebrow: 'Stop 1 of 2', paragraphs: ['Gallery'], buttons: [{ id: 'next', label: 'Next', primary: true }] };
  session.setXrPanel(panel);
  assert.deepEqual(renderers[0].xrPanel, panel);
  const transition = session.goTo(0, 1);
  assert.equal(renderers[0].xr.yaw, 1.2, 'the outgoing space keeps the headset while the next one loads');
  renderers[1].complete(); await transition;
  assert.deepEqual(renderers[1].xr, { session: 'headset', yaw: 1.2 });
  assert.equal(renderers[0].xr, null);
  assert.deepEqual(renderers[1].xrPanel, panel);
});

test('a failed later load clears the indicator, retains the current stop and can retry', async t => {
  const { session, container } = setup(t);
  await open(session);
  const pending = session.goTo(0, 1);
  renderers[1].fail(new Error('Model download failed')); await pending;
  assert.equal(session.getState().loading.ready, true);
  assert.equal(session.getState().loading.busy, undefined);
  assert.equal(session.getState().activePointIndex, 0);
  assert.equal(session.getState().navigating, false);
  assert.equal(session.getState().navigationError, 'Model download failed');
  assert.equal(container.children[0].removed, undefined);
  assert.equal(container.children[1].removed, true);
  const retry = session.goTo(0, 1);
  assert.equal(session.getState().navigationError, undefined);
  renderers[2].complete(); await retry;
  assert.equal(session.getState().activePointIndex, 1);
});

test('disposing during a model load never reveals a late renderer', async t => {
  const { session, container } = setup(t);
  await open(session);
  const pending = session.goTo(0, 1);
  session.dispose(); renderers[1].complete(); await pending;
  assert.equal(container.children[1].style.opacity, '0');
  assert.equal(renderers[0].disposed, true);
  assert.equal(renderers[1].disposed, true);
});

test('a context lost from the start that comes back opens the space on its canvas', async t => {
  const { session, container, restored } = setup(t);
  contexts.push('lost');
  const opening = session.init();
  await settle();
  assert.equal(renderers.length, 0);
  const canvas = container.children[0].children[0];
  canvas.gl.lost = false;
  for (const listener of canvas.listeners.webglcontextrestored) listener();
  await settle();
  assert.equal(renderers[0].canvas, canvas);
  renderers[0].complete(); await opening;
  assert.equal(session.getState().loading.ready, true);
  assert.match(restored[0], /^lost at start, back after/);
});

test('a new canvas takes over when the lost context stays lost', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, container, restored } = setup(t);
  contexts.push('lost', 'ready');
  const opening = session.init();
  await settle();
  const [first] = container.children[0].children;
  t.mock.timers.tick(3000);
  await settle();
  assert.equal(first.removed, true);
  assert.notEqual(renderers[0].canvas, first);
  renderers[0].complete(); await opening;
  assert.equal(session.getState().loading.ready, true);
  assert.match(restored[0], /^lost at start, a new canvas drew/);
});

test('a space whose graphics never start says so in plain words instead of failing in three.js', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session } = setup(t);
  contexts.push('lost', 'lost');
  const opening = session.init();
  const failure = assert.rejects(opening, error => error.graphics === 'lost' && /quit and reopen the browser/.test(error.message) && /a new canvas lost too/.test(error.details));
  await settle(); t.mock.timers.tick(3000);
  await settle(); t.mock.timers.tick(3000);
  await failure;
  assert.equal(renderers.length, 0);
});

test('a browser without WebGL 2 is told so at once', async t => {
  const { session } = setup(t);
  contexts.push('none');
  await assert.rejects(session.init(), error => error.graphics === 'none' && /can't show 3D graphics/.test(error.message));
  assert.equal(renderers.length, 0);
});
