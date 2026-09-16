import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioController } from '../lib/three/AudioController.ts';

const audio = [];
let playbackAllowed = false;
globalThis.window = new EventTarget();
globalThis.requestAnimationFrame = () => 0;
globalThis.Audio = class {
  paused = true;
  attempts = 0;
  volume = 0;
  constructor(url) { this.src=url; audio.push(this); }
  async play() {
    this.attempts++;
    if (!playbackAllowed) throw new DOMException('User gesture required', 'NotAllowedError');
    this.paused=false;
  }
  pause() { this.paused=true; }
};
const config = { narration:{url:'/narration.mp3'}, other:{url:'/other.mp3'} };

test('automatically started narration resumes on ordinary interaction after browser rejection', async () => {
  playbackAllowed=false;
  const controller=new AudioController(config);
  const narration=audio.at(-2);
  controller.updateForPoint({sounds:['narration']});
  await Promise.resolve();
  assert.equal(narration.paused,true);
  playbackAllowed=true;
  window.dispatchEvent(new Event('pointerup'));
  assert.equal(narration.paused,false);
  assert.equal(narration.attempts,2);
  controller.dispose();
});
test('leaving a tour point never replays its blocked narration on a later gesture', async () => {
  playbackAllowed=false;
  const controller=new AudioController(config);
  const narration=audio.at(-2);
  controller.updateForPoint({sounds:['narration']});
  await Promise.resolve();
  controller.updateForPoint({sounds:[]});
  playbackAllowed=true;
  window.dispatchEvent(new Event('keydown'));
  assert.equal(narration.paused,true);
  assert.equal(narration.attempts,1);
  controller.dispose();
});
test('disposing a scene removes its deferred audio playback', async () => {
  playbackAllowed=false;
  const controller=new AudioController(config);
  const narration=audio.at(-2);
  controller.updateForPoint({sounds:['narration']});
  await Promise.resolve();
  controller.dispose();
  playbackAllowed=true;
  window.dispatchEvent(new Event('pointerup'));
  assert.equal(narration.attempts,1);
});
