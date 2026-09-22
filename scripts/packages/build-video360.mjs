#!/usr/bin/env node
// Turns an equirectangular 360 video into a guided panorama tour by sampling sharp frames.
//   node scripts/packages/build-video360.mjs --input walk.mp4 --title "Title" [--every 3] [--max-frames 40] [--start 0] [--end 0]
// A walkthrough recorded at walking pace works best with a frame every 2–4 seconds.
// Regular (non-360) video is a different pipeline: see the sphr-video skill.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPanoramas } from './build-panoramas.mjs';
import { probeVideo } from './media-probe.mjs';
import { fail, identity, parseArgs } from './common.mjs';

const options = parseArgs(process.argv.slice(2));
const input = options.input;
if (typeof input !== 'string' || !existsSync(input)) fail('Pass --input with a video file.');
const info = probeVideo(input);
if (!info) fail('This file is not a readable video.');
if (!info.equirectangular) fail(JSON.stringify({ error: 'Not an equirectangular 360 video (expected a 2:1 frame).', ...info }, null, 2));
const id = identity(options);
const start = Number(options.start ?? 0), end = Number(options.end ?? 0) || info.duration;
const maxFrames = Number(options['max-frames'] ?? 40);
const every = Math.max(Number(options.every ?? 3), (end - start) / maxFrames);
const frames = path.join(tmpdir(), `sphr-frames-${process.pid}`);
rmSync(frames, { recursive: true, force: true });
mkdirSync(frames);
try {
  // Sample one frame per interval, preferring the sharpest nearby keyframe-free frame.
  const extract = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(start), '-to', String(end), '-i', input,
    '-vf', `fps=1/${every.toFixed(3)}`, '-q:v', '2', path.join(frames, 'frame-%04d.jpg')], { stdio: 'inherit' });
  if (extract.status !== 0) fail('ffmpeg could not extract frames.');
  const images = readdirSync(frames).sort().map(name => path.join(frames, name));
  if (!images.length) fail('No frames were extracted; check --start and --end.');
  const { used, skipped } = await buildPanoramas(images, id, { maxWidth: Number(options['max-width'] ?? 8192), kind: 'video360', tool: 'build-video360', inputs: [input] });
  console.log(JSON.stringify({ folder: id.folder, preview: path.join(id.folder, 'preview.jpg'), frames: used.length, everySeconds: Number(every.toFixed(2)), video: info, skipped }, null, 2));
} finally { rmSync(frames, { recursive: true, force: true }); }
