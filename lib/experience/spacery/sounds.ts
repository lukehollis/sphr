import type { SoundRenderer } from "@/lib/experience/registry";
import { bell, noiseSource, note, pad, pluck, render, sweep } from "@/lib/experience/synth";

/** Spacery's sound library: recordings from the original garden tour, and generated beds and music. */

/** A recording on static.mused.org; short effects are brought to the same peak as the synthesized ones. */
const hosted = (url: string, peak?: number): SoundRenderer => async (rate) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = await new OfflineAudioContext(2, 1, rate).decodeAudioData(await response.arrayBuffer());
  if (!peak) return buffer;
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
  const highest = Math.max(...channels.map((data) => data.reduce((max, value) => Math.max(max, Math.abs(value)), 0)));
  if (highest > 1e-4) for (const data of channels) for (let index = 0; index < data.length; index += 1) data[index] *= peak / highest;
  return buffer;
};

export const gardenMusic = hosted("https://static.mused.org/sounds/harumachi_peaceful_garden.mp3");
export const gardenBirds = hosted("https://static.mused.org/sounds/backyard_garden_birds.mp3");
export const nightAmbience = hosted("https://static.mused.org/sounds/night_ambience.mp3");
export const ding = hosted("https://static.mused.org/sounds/interface_ding.mp3", 0.6);
export const drum = hosted("https://static.mused.org/sounds/bassdrum_64k.mp3", 0.6);
export const lowBell = hosted("https://static.mused.org/sounds/bell_low_0.mp3", 0.6);
export const lowBellHigh = hosted("https://static.mused.org/sounds/bell_low_2.mp3", 0.6);

// ---- Sound effects ----

export const coin: SoundRenderer = (rate) => render(0.6, rate, (context, output) => {
  for (const [time, midi] of [[0, 83], [0.07, 88]] as const) {
    const oscillator = context.createOscillator();
    oscillator.type = "square";
    oscillator.frequency.value = note(midi);
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.0001, time);
    envelope.gain.linearRampToValueAtTime(0.18, time + 0.005);
    envelope.gain.exponentialRampToValueAtTime(0.0001, time + (midi === 88 ? 0.45 : 0.08));
    oscillator.connect(envelope).connect(output);
    oscillator.start(time);
    oscillator.stop(time + 0.5);
  }
}, { reverb: 0.15 });

export const magic: SoundRenderer = (rate) => render(3, rate, (context, output, random) => {
  sweep(context, output, 0, 1.4, 600, 6000, 0.12, random, 3);
  [72, 76, 79, 83, 86, 88, 91, 95].forEach((midi, index) => pluck(context, output, 0.1 + index * 0.08, note(midi), 0.09, 1.4, random() * 1.6 - 0.8, "sine"));
  bell(context, output, 0.75, note(96), 0.12, 1.8);
}, { reverb: 0.6 });

export const harp: SoundRenderer = (rate) => render(3.2, rate, (context, output) => {
  const scale = [60, 62, 64, 67, 69, 72, 74, 76, 79, 81, 84, 86, 88];
  scale.forEach((midi, index) => pluck(context, output, index * 0.045, note(midi), 0.1, 2.2, index / scale.length - 0.5, "triangle"));
}, { reverb: 0.55 });

export const gong: SoundRenderer = (rate) => render(7, rate, (context, output) => {
  for (const [ratio, level, decay] of [[1, 0.3, 6], [1.48, 0.18, 5], [2.13, 0.12, 4], [2.98, 0.08, 3.5], [4.1, 0.05, 2.5]]) {
    const oscillator = context.createOscillator();
    oscillator.frequency.setValueAtTime(note(43) * ratio * 1.01, 0);
    oscillator.frequency.exponentialRampToValueAtTime(note(43) * ratio, 2);
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, 0);
    envelope.gain.linearRampToValueAtTime(level, 0.02);
    envelope.gain.exponentialRampToValueAtTime(0.0001, decay);
    oscillator.connect(envelope).connect(output);
    oscillator.start(0);
    oscillator.stop(decay + 0.1);
  }
}, { reverb: 0.5 });

export const shutter: SoundRenderer = (rate) => render(0.4, rate, (context, output, random) => {
  for (const time of [0, 0.09]) {
    const source = noiseSource(context, 0.05, random);
    const filter = context.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = 2000;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.5, time);
    envelope.gain.exponentialRampToValueAtTime(0.0001, time + 0.04);
    source.connect(filter).connect(envelope).connect(output);
    source.start(time);
  }
});

export const fanfare: SoundRenderer = (rate) => render(3.4, rate, (context, output) => {
  const notes: [number, number, number][] = [[0, 67, 0.18], [0.18, 67, 0.12], [0.3, 72, 0.4], [0.7, 76, 0.35], [1.05, 79, 1.6]];
  for (const [time, midi, length] of notes) {
    for (const [type, level] of [["sawtooth", 0.07], ["square", 0.035]] as const) {
      const oscillator = context.createOscillator();
      oscillator.type = type;
      oscillator.frequency.value = note(midi);
      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(800, time);
      filter.frequency.linearRampToValueAtTime(2600, time + 0.08);
      const envelope = context.createGain();
      envelope.gain.setValueAtTime(0, time);
      envelope.gain.linearRampToValueAtTime(level, time + 0.03);
      envelope.gain.setValueAtTime(level, time + length * 0.8);
      envelope.gain.linearRampToValueAtTime(0, time + length);
      oscillator.connect(filter).connect(envelope).connect(output);
      oscillator.start(time);
      oscillator.stop(time + length + 0.05);
    }
  }
}, { reverb: 0.35 });

// ---- Ambient beds (seamless loops) ----

function noiseBed(context: OfflineAudioContext, output: AudioNode, random: () => number, seconds: number, type: BiquadFilterType, frequency: number, gain: number, wobble = 0, period = 8) {
  const source = noiseSource(context, seconds + 4, random);
  const filter = context.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  const level = context.createGain();
  level.gain.value = gain;
  if (wobble) {
    const lfo = context.createOscillator();
    lfo.frequency.value = 1 / period;
    const depth = context.createGain();
    depth.gain.value = wobble;
    lfo.connect(depth).connect(filter.frequency);
    lfo.start(0);
  }
  source.connect(filter).connect(level).connect(output);
  source.start(0);
  return level;
}

export const wind: SoundRenderer = (rate) => render(32, rate, (context, output, random) => {
  noiseBed(context, output, random, 32, "bandpass", 420, 0.5, 260, 8);
  for (let index = 0; index < 5; index += 1) sweep(context, output, random() * 26, 4 + random() * 3, 300, 900 + random() * 600, 0.3, random, 0.8);
}, { loop: true, seed: 3 });

export const rain: SoundRenderer = (rate) => render(24, rate, (context, output, random) => {
  noiseBed(context, output, random, 24, "highpass", 1200, 0.25);
  noiseBed(context, output, random, 24, "lowpass", 400, 0.2);
  for (let index = 0; index < 220; index += 1) pluck(context, output, random() * 23.5, 1800 + random() * 2600, 0.025 * random(), 0.05, random() * 2 - 1, "sine");
}, { loop: true, seed: 5 });

export const waves: SoundRenderer = (rate) => render(32, rate, (context, output, random) => {
  for (let index = 0; index < 4; index += 1) {
    const start = index * 8 + random();
    sweep(context, output, start, 7, 300, 900, 0.6, random, 0.5);
    sweep(context, output, start + 2.5, 5, 1800, 600, 0.25, random, 0.7);
  }
  noiseBed(context, output, random, 32, "lowpass", 220, 0.15);
}, { loop: true, seed: 9 });

export const forest: SoundRenderer = (rate) => render(40, rate, (context, output, random) => {
  noiseBed(context, output, random, 40, "bandpass", 700, 0.12, 120, 10);
  for (let call = 0; call < 26; call += 1) {
    const time = random() * 37;
    const base = 2200 + random() * 2200;
    const notes = 2 + Math.floor(random() * 4);
    const pan = random() * 1.6 - 0.8;
    for (let index = 0; index < notes; index += 1) {
      const oscillator = context.createOscillator();
      const start = time + index * (0.09 + random() * 0.06);
      oscillator.frequency.setValueAtTime(base * (1 + random() * 0.2), start);
      oscillator.frequency.exponentialRampToValueAtTime(base * (0.75 + random() * 0.6), start + 0.08);
      const envelope = context.createGain();
      envelope.gain.setValueAtTime(0, start);
      envelope.gain.linearRampToValueAtTime(0.05, start + 0.01);
      envelope.gain.exponentialRampToValueAtTime(0.0001, start + 0.11);
      const panner = context.createStereoPanner();
      panner.pan.value = pan;
      oscillator.connect(envelope).connect(panner).connect(output);
      oscillator.start(start);
      oscillator.stop(start + 0.15);
    }
  }
}, { loop: true, reverb: 0.3, seed: 13 });

export const fire: SoundRenderer = (rate) => render(20, rate, (context, output, random) => {
  noiseBed(context, output, random, 20, "lowpass", 300, 0.35, 80, 5);
  for (let index = 0; index < 160; index += 1) {
    const time = random() * 19.6;
    const source = noiseSource(context, 0.03, random);
    const filter = context.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 1200 + random() * 3000;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.3 * random(), time);
    envelope.gain.exponentialRampToValueAtTime(0.0001, time + 0.02 + random() * 0.03);
    source.connect(filter).connect(envelope).connect(output);
    source.start(time);
  }
}, { loop: true, seed: 17 });

export const cave: SoundRenderer = (rate) => render(30, rate, (context, output, random) => {
  pad(context, output, 0, [note(31), note(38)], 33, 0.05, 220);
  for (let index = 0; index < 14; index += 1) bell(context, output, random() * 28, 1100 + random() * 900, 0.05, 0.6, random() * 1.6 - 0.8);
}, { loop: true, reverb: 0.8, seed: 19 });

export const space: SoundRenderer = (rate) => render(40, rate, (context, output, random) => {
  pad(context, output, 0, [note(36), note(43), note(50), note(55)], 43, 0.05, 500);
  for (let index = 0; index < 8; index += 1) pluck(context, output, random() * 38, note(84 + Math.floor(random() * 12)), 0.04, 3, random() * 1.6 - 0.8, "sine");
}, { loop: true, reverb: 0.7, seed: 23 });

export const crickets: SoundRenderer = (rate) => render(20, rate, (context, output, random) => {
  noiseBed(context, output, random, 20, "lowpass", 250, 0.08);
  for (let chirp = 0; chirp < 70; chirp += 1) {
    const time = random() * 19.5;
    const frequency = 4200 + random() * 900;
    const pan = random() * 1.6 - 0.8;
    for (let pulse = 0; pulse < 3; pulse += 1) {
      const start = time + pulse * 0.045;
      const oscillator = context.createOscillator();
      oscillator.frequency.value = frequency;
      const envelope = context.createGain();
      envelope.gain.setValueAtTime(0, start);
      envelope.gain.linearRampToValueAtTime(0.03, start + 0.008);
      envelope.gain.linearRampToValueAtTime(0, start + 0.03);
      const panner = context.createStereoPanner();
      panner.pan.value = pan;
      oscillator.connect(envelope).connect(panner).connect(output);
      oscillator.start(start);
      oscillator.stop(start + 0.04);
    }
  }
}, { loop: true, seed: 29 });

// ---- Music (generated loops) ----

/** Chords for eight bars of eight seconds, a melody scale, and a feel. */
function piece(context: OfflineAudioContext, output: AudioNode, random: () => number, chords: number[][], scale: number[], options: { bar?: number; density?: number; arpeggio?: boolean; bass?: boolean; cutoff?: number; type?: OscillatorType }) {
  const bar = options.bar ?? 8;
  for (let index = 0; index < 8; index += 1) {
    const chord = chords[index % chords.length];
    const start = index * bar;
    pad(context, output, start, chord.map(note), bar, 0.032, options.cutoff ?? 800);
    if (options.bass !== false) pluck(context, output, start, note(chord[0] - 12), 0.13, bar * 0.7, 0, "sine");
    const steps = options.arpeggio ? 16 : 8;
    for (let step = 0; step < steps; step += 1) {
      const time = start + step * (bar / steps);
      if (options.arpeggio) pluck(context, output, time, note(chord[step % chord.length] + 12), 0.055, 0.8, (step % 4) / 2 - 0.75, options.type ?? "triangle");
      else if (random() < (options.density ?? 0.4)) pluck(context, output, time + (random() < 0.3 ? bar / steps / 2 : 0), note(scale[Math.floor(random() * scale.length)]), 0.07 + random() * 0.04, 2.2, random() * 0.8 - 0.4, options.type ?? "sine");
    }
  }
}

export const wonder: SoundRenderer = (rate) => render(64, rate, (context, output, random) => {
  piece(context, output, random, [[60, 64, 67, 71], [62, 66, 69, 72], [64, 67, 71, 74], [62, 66, 69, 73]], [72, 74, 76, 78, 79, 81, 83, 84], { arpeggio: true, cutoff: 1100 });
}, { reverb: 0.6, loop: true, seed: 31 });

export const mystery: SoundRenderer = (rate) => render(64, rate, (context, output, random) => {
  piece(context, output, random, [[57, 60, 64], [53, 57, 60], [52, 56, 59], [57, 60, 63]], [69, 71, 72, 74, 76, 77, 80], { density: 0.25, cutoff: 650 });
  for (let index = 0; index < 6; index += 1) bell(context, output, random() * 60, note(81 + Math.floor(random() * 7)), 0.05, 3, random() * 1.2 - 0.6);
}, { reverb: 0.7, loop: true, seed: 37 });

export const adventure: SoundRenderer = (rate) => render(48, rate, (context, output, random) => {
  piece(context, output, random, [[62, 65, 69], [58, 62, 65], [60, 64, 67], [57, 61, 64]], [74, 76, 77, 79, 81], { bar: 6, arpeggio: true, cutoff: 1500, type: "sawtooth" });
  for (let beat = 0; beat < 96; beat += 1) {
    const time = beat * 0.5;
    const oscillator = context.createOscillator();
    oscillator.frequency.setValueAtTime(beat % 4 === 0 ? 120 : 90, time);
    oscillator.frequency.exponentialRampToValueAtTime(45, time + 0.12);
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(beat % 2 === 0 ? 0.35 : 0.12, time);
    envelope.gain.exponentialRampToValueAtTime(0.0001, time + 0.2);
    oscillator.connect(envelope).connect(output);
    oscillator.start(time);
    oscillator.stop(time + 0.25);
  }
}, { reverb: 0.35, loop: true, seed: 41 });

export const playful: SoundRenderer = (rate) => render(48, rate, (context, output, random) => {
  piece(context, output, random, [[60, 64, 67], [65, 69, 72], [67, 71, 74], [60, 64, 67]], [72, 74, 76, 79, 81, 84], { bar: 6, density: 0.6, cutoff: 1400, type: "triangle" });
  for (let beat = 0; beat < 96; beat += 1) if (beat % 2 === 1) pluck(context, output, beat * 0.5, note(beat % 4 === 1 ? 79 : 76), 0.04, 0.15, 0.3, "square");
}, { reverb: 0.3, loop: true, seed: 43 });

export const nocturne: SoundRenderer = (rate) => render(64, rate, (context, output, random) => {
  piece(context, output, random, [[57, 60, 64, 67], [53, 57, 60, 64], [50, 53, 57, 60], [52, 56, 59, 62]], [69, 71, 72, 74, 76, 79], { density: 0.3, cutoff: 700 });
}, { reverb: 0.7, loop: true, seed: 47 });
