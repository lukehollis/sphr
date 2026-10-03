import * as THREE from "three";
import type { EffectFactory, EffectHandle } from "@/lib/experience/registry";
import { num, str } from "@/lib/experience/registry";

/**
 * A sound effect. On an object or a spot it is positional: it pans with the
 * view and fades with distance. It plays when a stop opens, loops while the
 * stop runs, or answers a hunt find, a hint or a click on its object.
 */
const create: EffectFactory = (context, instance) => {
  let params = instance.params;
  const audio = context.audio();
  const positional = instance.target.kind !== "scene";
  const holder = new THREE.Object3D();
  holder.name = `effect-sound-${instance.id}`;
  context.scene.add(holder);
  const voice = (positional ? new THREE.PositionalAudio(audio.listener) : new THREE.Audio(audio.listener)) as THREE.Audio<GainNode | PannerNode>;
  holder.add(voice);
  const anchor = new THREE.Vector3();
  let buffer: AudioBuffer | null = null;
  let source = "";
  let active = false;
  let disposed = false;

  const load = async () => {
    const wanted = str(params, "sound", "chime");
    if (wanted === source && buffer) return buffer;
    source = wanted;
    buffer = await audio.buffer(wanted);
    if (buffer && !disposed) voice.setBuffer(buffer);
    return buffer;
  };

  const configure = () => {
    if (voice instanceof THREE.PositionalAudio) {
      const range = num(params, "range", 6);
      voice.setRefDistance(Math.max(0.5, range / 4));
      voice.setRolloffFactor(1.4);
      voice.setDistanceModel("inverse");
    }
  };
  configure();

  const fadeTo = (level: number, seconds: number) => {
    const gain = voice.gain.gain;
    const now = audio.context.currentTime;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(level, now + Math.max(0.01, seconds));
  };

  const start = async (loop: boolean) => {
    if (!(await load()) || disposed) return;
    if (voice.isPlaying) voice.stop();
    voice.setLoop(loop);
    voice.gain.gain.value = loop ? 0 : num(params, "volume", 0.7);
    voice.play();
    if (loop) fadeTo(num(params, "volume", 0.7), 1.2);
  };

  const stop = (seconds = 0.8) => {
    if (!voice.isPlaying) return;
    fadeTo(0, seconds);
    window.setTimeout(() => { if (!active && voice.isPlaying) voice.stop(); }, seconds * 1000 + 50);
  };

  void load();

  const handle: EffectHandle = {
    update() {
      if (!positional) return;
      context.anchor(anchor);
      holder.position.copy(anchor);
    },
    setActive(value) {
      const trigger = str(params, "trigger", "enter");
      if (value && !active) {
        if (trigger === "enter") void start(false);
        if (trigger === "loop") void start(true);
      }
      if (!value && active && trigger === "loop") stop();
      active = value;
    },
    play(cue) {
      if (cue === str(params, "trigger", "enter")) void start(false);
    },
    setParams(next) {
      const before = str(params, "sound", "chime") + str(params, "trigger", "enter");
      params = next;
      configure();
      if (str(params, "sound", "chime") + str(params, "trigger", "enter") !== before) {
        if (voice.isPlaying) voice.stop();
        void load().then(() => { if (active && str(params, "trigger", "enter") === "loop") void start(true); });
      } else if (voice.isPlaying && str(params, "trigger", "enter") === "loop") fadeTo(num(params, "volume", 0.7), 0.2);
    },
    dispose() {
      disposed = true;
      if (voice.isPlaying) voice.stop();
      voice.disconnect();
      context.scene.remove(holder);
    }
  };
  return handle;
};

export default create;
