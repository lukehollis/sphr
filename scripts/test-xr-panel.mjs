import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';

// Resolve the app's "@/" alias and extensionless TypeScript imports.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@/')) {
      const base = new URL(`../${specifier.slice(2)}`, import.meta.url);
      for (const candidate of [`${base.href}.ts`, `${base.href}/index.ts`]) if (existsSync(fileURLToPath(candidate))) return next(candidate, context);
    }
    if (specifier.startsWith('.') && context.parentURL?.endsWith('.ts') && !/\.[a-z]+$/.test(specifier)) {
      const base = new URL(specifier, context.parentURL);
      for (const candidate of [`${base.href}.ts`, `${base.href}/index.ts`]) if (existsSync(fileURLToPath(candidate))) return next(candidate, context);
    }
    return next(specifier, context);
  }
});

const { xrPanelFor, nextButtonLabel } = await import('../lib/xr-panel.ts');

const state = (extra = {}) => ({ loading: { label: 'Ready', progress: 1, ready: true }, activeSpaceIndex: 0, activePointIndex: 1,
  viewMode: 'FPV', guided: true, muted: false, showText: true, debug: false, navigating: false, ...extra });
const stop = { id: 'two', format: 'plain', title: 'The west wall', text: 'The maize god.\n\nHe rises from the water.' };
const ids = (panel) => panel.buttons.map((button) => `${button.id}${button.enabled === false ? ' (off)' : ''}${button.primary ? ' *' : ''}`);

test('a guided stop shows its place in the tour, its text and Previous and Next', () => {
  const panel = xrPanelFor({ state: state(), point: stop, hasGuidedTour: true, isLastPoint: false, stop: { index: 2, count: 9 } });
  assert.equal(panel.eyebrow, 'Stop 2 of 9');
  assert.equal(panel.title, 'The west wall');
  assert.deepEqual(panel.paragraphs, ['The maize god.', 'He rises from the water.']);
  assert.deepEqual(ids(panel), ['previous', 'next *']);
  assert.equal(panel.buttons[1].label, 'Next');
});

test('buttons wait while the viewer moves, and Previous waits at the first stop', () => {
  const moving = xrPanelFor({ state: state({ navigating: true }), point: stop, hasGuidedTour: true, isLastPoint: false });
  assert.deepEqual(ids(moving), ['previous (off)', 'next (off) *']);
  const first = xrPanelFor({ state: state({ activePointIndex: 0 }), point: stop, hasGuidedTour: true, isLastPoint: false });
  assert.deepEqual(ids(first), ['previous (off)', 'next *']);
});

test('the last stop offers the onward page, or Continue exploring', () => {
  const onward = xrPanelFor({ state: state(), point: stop, hasGuidedTour: true, isLastPoint: true, continueTo: { url: '/s/abc/next', label: 'On to the temple' } });
  assert.deepEqual(ids(onward), ['previous', 'continue *']);
  assert.equal(onward.buttons[1].label, 'On to the temple');
  const end = xrPanelFor({ state: state(), point: stop, hasGuidedTour: true, isLastPoint: true });
  assert.equal(end.buttons[1].label, 'Continue exploring');
});

test('a hunt clue locks Next until its object is found, with a hint and how to pick it', () => {
  const clue = { ...stop, find: { objectId: 'scarab', hint: 'Look down the steps.', found: 'A scarab!' } };
  const hunt = { step: 1, steps: 6, found: 0 };
  const locked = xrPanelFor({ state: state({ hunt: { found: [], stepFound: false, hint: false } }), point: clue, hasGuidedTour: true, isLastPoint: false, hunt });
  assert.equal(locked.eyebrow, 'Clue 1 of 6');
  assert.deepEqual(ids(locked), ['previous', 'hint', 'next (off) *']);
  assert.equal(locked.buttons[2].label, 'Find it to go on');
  assert.match(locked.note, /trigger/);
  const hinted = xrPanelFor({ state: state({ hunt: { found: [], stepFound: false, hint: true } }), point: clue, hasGuidedTour: true, isLastPoint: false, hunt });
  assert.equal(hinted.note, 'Look down the steps.');
  assert.equal(hinted.buttons[1].label, 'Look for the light');
  const found = xrPanelFor({ state: state({ hunt: { found: ['scarab'], stepFound: true, hint: true } }), point: clue, hasGuidedTour: true, isLastPoint: false, hunt });
  assert.equal(found.eyebrow, 'Found');
  assert.deepEqual(found.paragraphs, ['A scarab!']);
  assert.deepEqual(ids(found), ['previous', 'next *']);
  assert.equal(found.buttons[1].label, nextButtonLabel({ locked: false, hunt: true, isLastPoint: false }));
});

test('the closing card, exploring freely, and spaces without a tour', () => {
  const finale = xrPanelFor({ state: state({ finished: true, guided: false }), point: stop, hasGuidedTour: true, isLastPoint: true, finale: 'Thank you for coming.', hunt: { step: 6, steps: 6, found: 5 } });
  assert.equal(finale.title, 'You found 5 of 6');
  assert.deepEqual(finale.paragraphs, ['Thank you for coming.']);
  assert.deepEqual(ids(finale), ['restart', 'explore *']);
  const free = xrPanelFor({ state: state({ guided: false }), point: stop, hasGuidedTour: true, isLastPoint: false, title: 'Delphi' });
  assert.equal(free.title, 'Delphi');
  assert.deepEqual(ids(free), ['guide *']);
  assert.equal(xrPanelFor({ state: state({ guided: false }), point: stop, hasGuidedTour: false, isLastPoint: false }), null);
});
