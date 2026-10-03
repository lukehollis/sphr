/**
 * Small building blocks for synthesizing sounds offline in the browser, so a
 * pack can ship chimes, ambient beds and music without audio files. Each
 * sound renders once into a buffer and is cached by the audio host.
 */

export type Build = (context: OfflineAudioContext, output: AudioNode, random: () => number) => void;

/** Deterministic random numbers, so a sound renders the same every time. */
export function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export const note = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

/** A decaying stereo noise impulse for a soft room or hall reverb. */
function impulse(context: BaseAudioContext, seconds: number, random: () => number) {
  const length = Math.floor(seconds * context.sampleRate);
  const buffer = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < length; index += 1) data[index] = (random() * 2 - 1) * Math.pow(1 - index / length, 3.2);
  }
  return buffer;
}

export function noiseBuffer(context: BaseAudioContext, seconds: number, random: () => number) {
  const length = Math.floor(seconds * context.sampleRate);
  const buffer = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    let brown = 0;
    for (let index = 0; index < length; index += 1) {
      const white = random() * 2 - 1;
      brown = (brown + 0.02 * white) / 1.02;
      data[index] = white * 0.35 + brown * 3.2;
    }
  }
  return buffer;
}

export function noiseSource(context: BaseAudioContext, seconds: number, random: () => number) {
  const source = context.createBufferSource();
  source.buffer = noiseBuffer(context, seconds, random);
  return source;
}

/**
 * Render a sound. With `loop`, the sound renders a little long and its tail is
 * crossfaded into its head so it repeats without a seam.
 */
export async function render(seconds: number, sampleRate: number, build: Build, options: { reverb?: number; loop?: boolean; seed?: number; gain?: number; peak?: number } = {}) {
  const random = seeded(options.seed ?? 7);
  const overlap = options.loop ? Math.min(3, seconds * 0.2) : 0;
  const context = new OfflineAudioContext(2, Math.ceil((seconds + overlap) * sampleRate), sampleRate);
  const master = context.createGain();
  master.gain.value = options.gain ?? 1;
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.ratio.value = 8;
  master.connect(limiter).connect(context.destination);
  let output: AudioNode = master;
  if (options.reverb) {
    const bus = context.createGain();
    const convolver = context.createConvolver();
    convolver.buffer = impulse(context, 2.8, seeded(99));
    const wet = context.createGain();
    wet.gain.value = options.reverb;
    bus.connect(master);
    bus.connect(convolver).connect(wet).connect(master);
    output = bus;
  }
  build(context, output, random);
  const rendered = await context.startRendering();
  return normalize(options.loop ? seamless(rendered, seconds, overlap) : rendered, options.peak ?? (options.loop ? 0.5 : 0.6));
}

/** Scale to a common peak so every sound sits at a similar level before its volume control. */
function normalize(buffer: AudioBuffer, peak: number) {
  let highest = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < data.length; index += 1) highest = Math.max(highest, Math.abs(data[index]));
  }
  if (highest < 1e-4) return buffer;
  const scale = peak / highest;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < data.length; index += 1) data[index] *= scale;
  }
  return buffer;
}

function seamless(buffer: AudioBuffer, seconds: number, overlap: number) {
  const length = Math.floor(seconds * buffer.sampleRate);
  const fade = Math.floor(overlap * buffer.sampleRate);
  const result = new AudioBuffer({ length, sampleRate: buffer.sampleRate, numberOfChannels: buffer.numberOfChannels });
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const source = buffer.getChannelData(channel);
    const target = result.getChannelData(channel);
    target.set(source.subarray(0, length));
    for (let index = 0; index < fade; index += 1) {
      const t = index / fade;
      target[index] = source[index] * Math.sin(t * Math.PI / 2) + source[index + length] * Math.cos(t * Math.PI / 2);
    }
  }
  return result;
}

/** A struck bell: inharmonic partials that ring out at their own rates. */
export function bell(context: BaseAudioContext, output: AudioNode, time: number, frequency: number, gain = 0.3, decay = 2.2, pan = 0) {
  const panner = context.createStereoPanner();
  panner.pan.value = pan;
  panner.connect(output);
  const partials: [number, number, number][] = [[1, 1, 1], [2.76, 0.45, 0.6], [5.4, 0.22, 0.4], [8.93, 0.1, 0.25], [0.5, 0.25, 1.2]];
  for (const [ratio, level, length] of partials) {
    const oscillator = context.createOscillator();
    oscillator.frequency.value = frequency * ratio;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, time);
    envelope.gain.linearRampToValueAtTime(gain * level, time + 0.004);
    envelope.gain.exponentialRampToValueAtTime(0.0001, time + decay * length);
    oscillator.connect(envelope).connect(panner);
    oscillator.start(time);
    oscillator.stop(time + decay * length + 0.05);
  }
}

/** A soft plucked note, for melodies and arpeggios. */
export function pluck(context: BaseAudioContext, output: AudioNode, time: number, frequency: number, gain = 0.2, decay = 1.2, pan = 0, type: OscillatorType = "triangle") {
  const panner = context.createStereoPanner();
  panner.pan.value = pan;
  panner.connect(output);
  const oscillator = context.createOscillator();
  oscillator.type = type;
  oscillator.frequency.value = frequency;
  const filter = context.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(frequency * 8, time);
  filter.frequency.exponentialRampToValueAtTime(frequency * 1.5, time + decay);
  const envelope = context.createGain();
  envelope.gain.setValueAtTime(0, time);
  envelope.gain.linearRampToValueAtTime(gain, time + 0.008);
  envelope.gain.exponentialRampToValueAtTime(0.0001, time + decay);
  oscillator.connect(filter).connect(envelope).connect(panner);
  oscillator.start(time);
  oscillator.stop(time + decay + 0.05);
}

/** A slow pad chord of detuned saws through a soft filter. */
export function pad(context: BaseAudioContext, output: AudioNode, time: number, frequencies: number[], duration: number, gain = 0.06, cutoff = 900) {
  const filter = context.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = cutoff;
  filter.Q.value = 0.4;
  const envelope = context.createGain();
  const attack = Math.min(2, duration * 0.3);
  envelope.gain.setValueAtTime(0, time);
  envelope.gain.linearRampToValueAtTime(gain, time + attack);
  envelope.gain.setValueAtTime(gain, time + duration - attack);
  envelope.gain.linearRampToValueAtTime(0, time + duration + 1.5);
  filter.connect(envelope).connect(output);
  for (const frequency of frequencies) {
    for (const detune of [-7, 0, 7]) {
      const oscillator = context.createOscillator();
      oscillator.type = "sawtooth";
      oscillator.frequency.value = frequency;
      oscillator.detune.value = detune;
      const panner = context.createStereoPanner();
      panner.pan.value = detune / 12;
      oscillator.connect(panner).connect(filter);
      oscillator.start(time);
      oscillator.stop(time + duration + 1.6);
    }
  }
}

/** Filtered noise with a gain envelope, for whooshes, wind and surf. */
export function sweep(context: BaseAudioContext, output: AudioNode, time: number, duration: number, from: number, to: number, gain: number, random: () => number, q = 1.2) {
  const source = noiseSource(context, duration + 0.1, random);
  const filter = context.createBiquadFilter();
  filter.type = "bandpass";
  filter.Q.value = q;
  filter.frequency.setValueAtTime(from, time);
  filter.frequency.exponentialRampToValueAtTime(to, time + duration);
  const envelope = context.createGain();
  envelope.gain.setValueAtTime(0, time);
  envelope.gain.linearRampToValueAtTime(gain, time + duration * 0.4);
  envelope.gain.linearRampToValueAtTime(0, time + duration);
  source.connect(filter).connect(envelope).connect(output);
  source.start(time);
  source.stop(time + duration + 0.05);
}
