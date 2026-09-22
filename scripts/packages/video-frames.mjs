#!/usr/bin/env node
// Extracts evenly spaced, de-duplicated frames from an ordinary video for reconstruction (COLMAP).
//   node scripts/packages/video-frames.mjs --input walk.mp4 --output work/frames [--fps 2] [--max-frames 300] [--width 1600]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { fail, parseArgs } from './common.mjs';
import { probeVideo } from './media-probe.mjs';

const options = parseArgs(process.argv.slice(2));
if (typeof options.input !== 'string' || !existsSync(options.input)) fail('Pass --input with a video file.');
if (typeof options.output !== 'string') fail('Pass --output with a folder for the frames.');
const info = probeVideo(options.input);
if (!info) fail('This file is not a readable video.');
const maxFrames = Number(options['max-frames'] ?? 300);
const fps = Math.min(Number(options.fps ?? 2), maxFrames / Math.max(1, info.duration));
const width = Number(options.width ?? 1600);
rmSync(options.output, { recursive: true, force: true });
mkdirSync(options.output, { recursive: true });
// mpdecimate drops near-duplicate frames from pauses before sampling.
const result = spawnSync('ffmpeg', ['-v', 'error', '-i', options.input, '-vf', `mpdecimate,fps=${fps.toFixed(3)},scale='min(${width},iw)':-2`,
  '-q:v', '2', `${options.output}/frame-%05d.jpg`], { stdio: 'inherit' });
if (result.status !== 0) fail('ffmpeg could not extract frames.');
const frames = readdirSync(options.output).filter(name => name.endsWith('.jpg')).length;
console.log(JSON.stringify({ frames, fps: Number(fps.toFixed(3)), video: info, output: options.output }, null, 2));
