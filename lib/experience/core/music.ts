import * as THREE from "three";
import type { EffectFactory, EffectHandle } from "@/lib/experience/registry";
import { num, str } from "@/lib/experience/registry";

/**
 * Background music or an ambient bed for the stops that list it, or the whole
 * visit. Tracks fade in and out, so moving between stops with different music
 * crossfades, and a track shared by consecutive stops plays on unbroken.
 */
const create: EffectFactory = (context, instance) => {
  let params = instance.params;
  const audio = context.audio();
  const voice = new THREE.Audio(audio.listener);
  voice.name = `effect-music-${instance.id}`;
  context.scene.add(voice);
  let source = "";
  let active = false;
  let disposed = false;
  let stopTimer = 0;

  const fadeTo = (level: number, seconds: number) => {
    const gain = voice.gain.gain;
    const now = audio.context.currentTime;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(level, now + Math.max(0.05, seconds));
  };

  const begin = async () => {
    const wanted = str(params, "track", "calm");
    if (wanted !== source) {
      if (voice.isPlaying) voice.stop();
      source = wanted;
      const buffer = await audio.buffer(wanted);
      if (!buffer || disposed || source !== wanted) return;
      voice.setBuffer(buffer);
    }
    if (!active || disposed) return;
    window.clearTimeout(stopTimer);
    if (!voice.isPlaying) {
      voice.setLoop(true);
      voice.gain.gain.value = 0;
      voice.play();
    }
    fadeTo(num(params, "volume", 0.35), num(params, "fade", 2));
  };

  const handle: EffectHandle = {
    update() {},
    setActive(value) {
      active = value;
      if (value) void begin();
      else if (voice.isPlaying) {
        const fade = num(params, "fade", 2);
        fadeTo(0, fade);
        window.clearTimeout(stopTimer);
        stopTimer = window.setTimeout(() => { if (!active && voice.isPlaying) voice.stop(); }, fade * 1000 + 100);
      }
    },
    setParams(next) {
      params = next;
      if (active) void begin();
    },
    dispose() {
      disposed = true;
      window.clearTimeout(stopTimer);
      if (voice.isPlaying) voice.stop();
      voice.disconnect();
      context.scene.remove(voice);
    }
  };
  return handle;
};

export default create;
