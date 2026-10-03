import type { SoundRenderer } from "@/lib/experience/registry";
import { bell, noiseSource, note, pad, pluck, render, sweep } from "@/lib/experience/synth";

/** The open source sound set, synthesized so the repository ships no audio files. */

export const chime: SoundRenderer = (rate) => render(2.6, rate, (context, output) => {
  bell(context, output, 0.01, note(84), 0.28, 2.2, -0.15);
  bell(context, output, 0.09, note(91), 0.16, 1.8, 0.2);
}, { reverb: 0.35 });

export const sparkle: SoundRenderer = (rate) => render(2, rate, (context, output, random) => {
  const notes = [84, 88, 91, 96, 100, 103];
  notes.forEach((midi, index) => pluck(context, output, 0.02 + index * 0.055 + random() * 0.01, note(midi), 0.12, 0.7, random() * 1.2 - 0.6, "sine"));
}, { reverb: 0.45 });

/** The hunt's reward: a rising major third and a shower of sparkles. */
export const found: SoundRenderer = (rate) => render(3, rate, (context, output, random) => {
  bell(context, output, 0.01, note(79), 0.24, 2.4, -0.2);
  bell(context, output, 0.16, note(83), 0.24, 2.4, 0.1);
  bell(context, output, 0.31, note(86), 0.26, 2.6, 0.25);
  [91, 95, 98, 103, 107].forEach((midi, index) => pluck(context, output, 0.36 + index * 0.05, note(midi), 0.07, 0.6, random() * 1.4 - 0.7, "sine"));
}, { reverb: 0.4 });

export const hint: SoundRenderer = (rate) => render(2.2, rate, (context, output) => {
  bell(context, output, 0.01, note(72), 0.2, 1.8);
  bell(context, output, 0.22, note(79), 0.12, 1.6);
}, { reverb: 0.5 });

export const pop: SoundRenderer = (rate) => render(0.4, rate, (context, output) => {
  const oscillator = context.createOscillator();
  oscillator.frequency.setValueAtTime(720, 0);
  oscillator.frequency.exponentialRampToValueAtTime(140, 0.09);
  const envelope = context.createGain();
  envelope.gain.setValueAtTime(0.5, 0);
  envelope.gain.exponentialRampToValueAtTime(0.0001, 0.14);
  oscillator.connect(envelope).connect(output);
  oscillator.start(0);
  oscillator.stop(0.2);
});

export const whoosh: SoundRenderer = (rate) => render(1.3, rate, (context, output, random) => {
  sweep(context, output, 0, 1.1, 260, 2600, 0.5, random, 0.9);
}, { reverb: 0.2 });

export const click: SoundRenderer = (rate) => render(0.15, rate, (context, output) => {
  const oscillator = context.createOscillator();
  oscillator.frequency.value = 1800;
  const envelope = context.createGain();
  envelope.gain.setValueAtTime(0.25, 0);
  envelope.gain.exponentialRampToValueAtTime(0.0001, 0.03);
  oscillator.connect(envelope).connect(output);
  oscillator.start(0);
  oscillator.stop(0.05);
});

/** A quiet room tone that breathes slowly, under narration or a hunt. */
export const air: SoundRenderer = (rate) => render(24, rate, (context, output, random) => {
  const source = noiseSource(context, 27, random);
  const filter = context.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 520;
  const gain = context.createGain();
  gain.gain.value = 0.09;
  const lfo = context.createOscillator();
  lfo.frequency.value = 1 / 8;
  const depth = context.createGain();
  depth.gain.value = 0.035;
  lfo.connect(depth).connect(gain.gain);
  source.connect(filter).connect(gain).connect(output);
  source.start(0);
  lfo.start(0);
}, { loop: true, peak: 0.35 });

/** Gentle generative piano-like music over soft chords, as a 64 second loop. */
export const calm: SoundRenderer = (rate) => render(64, rate, (context, output, random) => {
  const chords = [[60, 64, 67, 71], [57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 67]];
  const scale = [72, 74, 76, 79, 81, 84, 86, 88];
  for (let bar = 0; bar < 8; bar += 1) {
    const chord = chords[bar % 4];
    pad(context, output, bar * 8, chord.map(note), 8, 0.035, 800);
    pluck(context, output, bar * 8, note(chord[0] - 12), 0.12, 6, 0, "sine");
    for (let beat = 0; beat < 8; beat += 1) {
      if (random() < 0.42) pluck(context, output, bar * 8 + beat + (random() < 0.3 ? 0.5 : 0), note(scale[Math.floor(random() * scale.length)]), 0.07 + random() * 0.04, 2.4, random() * 0.8 - 0.4, "sine");
    }
  }
}, { reverb: 0.55, loop: true, seed: 11 });
