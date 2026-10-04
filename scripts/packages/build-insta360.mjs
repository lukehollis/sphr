#!/usr/bin/env node
// Turns the raw files from an Insta360 camera into a guided panorama tour, without Insta360 Studio:
//   - .insv videos recorded one file per lens (VID_<date>_<time>_00_<n>.insv + VID_..._10_<n>.insv, ONE RS 1-Inch),
//   - .insv videos that hold both lenses in one file (one 2:1 frame or two video streams, ONE X series),
//   - .insp stills (both lenses in one image; HDR brackets share a timestamp and the most evenly exposed is used).
// Each video is sampled every few seconds, after cutting the camera stand being lifted and lowered (from the
// camera's IMU when telemetry-parser is installed). Frames and stills are stitched by insta360_stitch.py with
// the lens calibration the camera records in each file: seams lined up with optical flow, the lenses' colour
// matched, a few neighbouring video frames merged against noise. Files without that calibration (or whose
// lenses then disagree) use ffmpeg's v360 filter with the settings measured on the ONE RS 1-Inch: 190 degree
// lenses stored rolled 180 degrees, a hard seam at +-90 degrees from the front. A sky upside down means the
// camera was mounted inverted (pass --roll 0, which always uses ffmpeg). --stitch ffmpeg forces the old stitch.
//   node scripts/packages/build-insta360.mjs --input <files or folders> --title "Title" [--every 2.5] [--max-frames 40]
//     [--width 5760] [--fov 190] [--roll 180] [--start S] [--end E] [--no-trim] [--stitch calibrated|ffmpeg]
// LRV_ files are the camera's low-resolution previews and are ignored.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { buildPanoramas } from './build-panoramas.mjs';
import { fail, identity, list, parseArgs } from './common.mjs';

const NAME = /^(VID|LRV|IMG)_(\d{8})_(\d{6})_(\d{2})_(\d{3})\.(insv|insp)$/i;
const here = path.dirname(fileURLToPath(import.meta.url));

const options = parseArgs(process.argv.slice(2));
const inputs = list(options.input);
if (!inputs.length || !inputs.every(existsSync)) fail('Pass --input with Insta360 .insv/.insp files or a folder of them.');
const fov = Number(options.fov ?? 190), roll = Number(options.roll ?? 180), width = Number(options.width ?? 5760);
const every = Number(options.every ?? 2.5), maxFrames = Number(options['max-frames'] ?? 40);
const python = process.env.SPHR_MATTERPORT_PYTHON || 'python3';
const calibratedStitch = (options.stitch ?? 'calibrated') === 'calibrated' && roll === 180 && fov === 190;

/** Calibrated stitch of a lens pair at several times, or of an .insp bracket; null when it does not apply. */
function calibrated(args) {
  if (!calibratedStitch) return null;
  const result = spawnSync(python, [path.join(here, 'insta360_stitch.py'), ...args], { encoding: 'utf8', maxBuffer: 1 << 24 });
  if (result.status === 0) return result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (result.status !== 3) console.error(`calibrated stitch failed, using ffmpeg: ${(result.stderr || '').trim().split('\n').pop()}`);
  return null;
}

function walk(target) {
  if (!statSync(target).isDirectory()) return [target];
  return readdirSync(target).filter(name => !name.startsWith('._')).flatMap(name => walk(path.join(target, name)));
}

function probe(file) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { encoding: 'utf8' });
  if (result.status !== 0) return undefined;
  const data = JSON.parse(result.stdout);
  const videos = data.streams.filter(stream => stream.codec_type === 'video');
  return { duration: Number(data.format.duration ?? videos[0]?.duration ?? 0), videos: videos.map(v => ({ width: v.width, height: v.height })) };
}

const v360 = w => `v360=input=dfisheye:output=e:ih_fov=${fov}:iv_fov=${fov}:roll=${roll}:w=${w}:h=${w / 2}:interp=lanczos`;

function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr.trim().split('\n').slice(-3).join(' ') || 'ffmpeg failed');
}

/** The usable part of a clip: the IMU trim when available, else a small fixed cut for the stand. */
function window(file, duration) {
  if (options.start !== undefined || options.end !== undefined) {
    return { start: Number(options.start ?? 0), end: Number(options.end ?? 0) || duration, method: 'given' };
  }
  if (options['no-trim']) return { start: 0, end: duration, method: 'none' };
  const result = spawnSync(python, [path.join(here, 'insta360_trim.py'), file], { encoding: 'utf8' });
  try {
    const imu = JSON.parse(result.stdout.trim());
    if (imu) return { ...imu, method: 'imu' };
  } catch { /* fall through */ }
  return duration > 8 ? { start: 1.5, end: duration - 1, method: 'fixed' } : { start: 0, end: duration, method: 'none' };
}

// ---- Group the camera files into captures ----
const skipped = [];
const videos = new Map(); // key -> { time, lenses: { '00': file, '10': file } }
const stills = new Map(); // date_time -> [files] (one HDR bracket)
for (const file of inputs.flatMap(walk)) {
  const match = path.basename(file).match(NAME);
  if (!match) { skipped.push({ file: path.basename(file), reason: 'not an Insta360 .insv or .insp file' }); continue; }
  const [, kind, date, time, lens, number, ext] = match;
  if (kind.toUpperCase() === 'LRV') { skipped.push({ file: path.basename(file), reason: 'low-resolution preview (LRV); the .insv files are used' }); continue; }
  if (ext.toLowerCase() === 'insp') {
    const group = stills.get(`${date}_${time}`) ?? [];
    stills.set(`${date}_${time}`, [...group, file]);
    continue;
  }
  const key = `${date}_${time}_${number}`;
  const entry = videos.get(key) ?? { time: `${date}_${time}`, lenses: {} };
  entry.lenses[lens] = file;
  videos.set(key, entry);
}

// ---- Work out each video's source and usable window ----
const clips = [];
for (const [key, entry] of videos) {
  const a = entry.lenses['00'], b = entry.lenses['10'];
  const info = probe(a ?? b);
  if (!info || !info.duration) { skipped.push({ file: path.basename(a ?? b), reason: 'not a readable video' }); continue; }
  let graph, files;
  if (a && b) {
    graph = `[0:v][1:v]hstack=inputs=2,${v360(width)}[out]`; files = [a, b];
  } else if (info.videos.length >= 2) {
    graph = `[0:v:0][0:v:1]hstack=inputs=2,${v360(width)}[out]`; files = [a ?? b];
  } else if (Math.abs(info.videos[0].width / info.videos[0].height - 2) < 0.1) {
    graph = `[0:v]${v360(width)}[out]`; files = [a ?? b];
  } else {
    skipped.push({ file: path.basename(a ?? b), reason: `only one lens of this video was uploaded; upload both VID_${key.replace(/_(\d{3})$/, '_00_$1')}.insv and the matching _10_ file` });
    continue;
  }
  const span = window(files[0], info.duration);
  clips.push({ key, time: entry.time, files, graph, duration: info.duration, ...span });
}

// Spread the frame budget over the usable footage.
const footage = clips.reduce((sum, clip) => sum + Math.max(0, clip.end - clip.start), 0);
const step = Math.max(every, footage / Math.max(1, maxFrames - stills.size));

const work = path.join(tmpdir(), `sphr-insta360-${process.pid}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
try {
  const shots = []; // { order, file }
  const stitchedStills = new Map();
  for (const clip of clips) {
    const times = [];
    for (let t = clip.start + Math.min(step / 2, (clip.end - clip.start) / 2); t < clip.end; t += step) times.push(Number(t.toFixed(2)));
    if (!times.length) times.push(Number(((clip.start + clip.end) / 2).toFixed(2)));
    clip.frames = 0;
    const done = clip.files.length === 2
      ? calibrated(['video', '--a', clip.files[0], '--b', clip.files[1], '--times', times.join(','), '--out-dir', path.join(work, clip.key), '--width', String(width)])
      : null;
    if (done) {
      for (const { t, out } of done) {
        shots.push({ order: `${clip.time}_${String(Math.round(t * 100)).padStart(7, '0')}`, file: out });
        clip.frames++;
      }
      clip.stitch = 'calibrated';
      continue;
    }
    clip.stitch = 'ffmpeg';
    for (const t of times) {
      const out = path.join(work, `${clip.time}_${clip.key}_${String(Math.round(t * 100)).padStart(6, '0')}.jpg`);
      try {
        ffmpeg([...clip.files.flatMap(file => ['-ss', String(t), '-i', file]), '-frames:v', '1', '-filter_complex', clip.graph,
          '-map', '[out]', '-q:v', '2', out]);
        shots.push({ order: `${clip.time}_${String(Math.round(t * 100)).padStart(7, '0')}`, file: out });
        clip.frames++;
      } catch (error) { skipped.push({ file: path.basename(clip.files[0]), reason: `frame at ${t}s could not be stitched: ${error.message}` }); }
    }
  }
  for (const [time, group] of stills) {
    // In an HDR bracket, use the exposure closest to mid grey.
    let best = group[0];
    if (group.length > 1) {
      const scored = await Promise.all(group.map(async file => {
        const stats = await sharp(file).resize(256).stats().catch(() => undefined);
        return { file, distance: stats ? Math.abs(stats.channels.slice(0, 3).reduce((s, c) => s + c.mean, 0) / 3 - 118) : 999 };
      }));
      best = scored.sort((x, y) => x.distance - y.distance)[0].file;
    }
    const out = path.join(work, `${time}_still.jpg`);
    // The calibrated stitch fuses the whole bracket (exposures that line up); ffmpeg uses the best exposure.
    if (calibrated(['still', '--insp', ...group.sort(), '--out', out, '--width', String(Math.min(width + 384, 6144))])) {
      shots.push({ order: `${time}_0000000`, file: out });
      stitchedStills.set(time, 'calibrated');
      continue;
    }
    try {
      ffmpeg(['-i', best, '-frames:v', '1', '-vf', v360(Math.min(width + 384, 6144)), '-q:v', '2', out]);
      shots.push({ order: `${time}_0000000`, file: out });
      stitchedStills.set(time, 'ffmpeg');
    } catch (error) { skipped.push({ file: path.basename(best), reason: `could not be stitched: ${error.message}` }); }
  }
  if (!shots.length) fail(JSON.stringify({ error: 'No Insta360 footage could be stitched.', skipped }, null, 2));
  shots.sort((x, y) => x.order.localeCompare(y.order));
  const id = identity(options);
  const sources = [...clips.flatMap(clip => clip.files), ...[...stills.values()].flat()];
  // Frames are named by camera timestamps; visitors see numbered stops in capture order instead.
  const { used, skipped: notPanoramas } = await buildPanoramas(shots.map(shot => shot.file), id,
    { maxWidth: Number(options['max-width'] ?? 8192), kind: 'insta360', tool: 'build-insta360', inputs: sources, labels: 'stops' });
  console.log(JSON.stringify({
    folder: id.folder, preview: path.join(id.folder, 'preview.jpg'), panoramas: used.length, everySeconds: Number(step.toFixed(2)),
    stitch: { fov, roll, width },
    videos: clips.map(({ key, files, duration, start, end, method, frames, stitch }) => ({ key, files: files.map(f => path.basename(f)), duration: Number(duration.toFixed(2)), kept: [start, end], trim: method, frames, stitch })),
    stills: [...stills.entries()].map(([time, group]) => ({ time, exposures: group.length, stitch: stitchedStills.get(time) })),
    skipped: [...skipped, ...notPanoramas]
  }, null, 2));
} finally { rmSync(work, { recursive: true, force: true }); }
