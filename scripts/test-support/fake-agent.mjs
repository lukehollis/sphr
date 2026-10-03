// Stands in for Claude Code or Codex in tests: builds a real package with the panorama tool,
// or behaves badly on request, so the runner's checks can be exercised.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const dir = process.argv[2];
const job = JSON.parse(readFileSync(path.join(dir, 'job.json'), 'utf8'));
const result = (status, message) => writeFileSync(path.join(dir, 'output/result.json'), JSON.stringify({ status, message }));
const progress = line => appendFileSync(path.join(dir, 'output/progress.log'), `${line}\n`);
// The runner must never hand the agent its own credentials.
if (Object.keys(process.env).some(name => /WORKER_TOKEN|STRIPE|PUBLISH/.test(name))) { result('failed', 'Credentials leaked to the agent.'); process.exit(0); }
if (!job.inputs.every(input => existsSync(input.path) && statSync(input.path).size === input.size)) { result('failed', 'Inputs missing.'); process.exit(0); }
if (!['splat', 'tour', 'auto'].includes(job.output)) { result('failed', 'job.json does not say what to build.'); process.exit(0); }
if (job.notes?.includes('needs a person')) { result('needs_operator', 'Unfamiliar capture format.'); process.exit(0); }
progress('Inspecting 1 file');
// Pretend the upload was a 360 photo: render one and package it with the real tool.
const photos = path.join(dir, 'work/photos');
mkdirSync(photos, { recursive: true });
await sharp({ create: { width: 1024, height: 512, channels: 3, background: '#3a6ea5' } }).jpeg().toFile(path.join(photos, 'room.jpg'));
progress('Building a panorama tour');
const built = spawnSync(process.execPath, [path.join(root, 'scripts/packages/build-panoramas.mjs'), '--input', photos, '--title', job.title], { encoding: 'utf8', env: process.env });
if (built.status !== 0) { result('failed', `Build failed: ${built.stderr}`); process.exit(0); }
const folder = path.join(dir, 'output/public/datasets/matterport', process.env.SPHR_SCENE_SLUG);
if (job.notes?.includes('tamper')) {
  // A steered agent adds files after packaging; the runner's validator must refuse them.
  writeFileSync(path.join(folder, 'evil.html'), '<script>alert(document.domain)</script>');
  symlinkSync('/etc/hosts', path.join(folder, 'pano/002.jpg'));
}
await new Promise(resolve => setTimeout(resolve, 4500));
result('ready', 'Built a panorama tour from your 360 photo.');
