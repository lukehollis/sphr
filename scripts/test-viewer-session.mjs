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
  const element = () => ({ dataset: {}, style: {}, children: [], append(child) { this.children.push(child); }, setAttribute() {}, remove() { this.removed = true; } });
  globalThis.document = { createElement: element };
  globalThis.renderers = [];
  const container = element(), states = [];
  const session = new ViewerSession(container, structuredClone(source), { onState: state => states.push(structuredClone(state)) });
  t.after(() => { session.dispose(); globalThis.document = priorDocument; globalThis.renderers = priorRenderers; });
  return { session, container, states };
}
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
