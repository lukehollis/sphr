#!/usr/bin/env node
// Checks an SPHR package before publication and, with --write, records validation.json.
//   node scripts/packages/validate-package.mjs <package folder> [--scene-id ID] [--slug SLUG] [--title TITLE] [--write]
// For "sphr-package-v1" every runtime file must be listed in the manifest with a matching
// SHA-256, have an allowed type, and stay inside the folder. For every package, bootstrap
// URLs may only point at files in the package: no other hosts, folders or script URLs.
// The processing runner runs its own copy of this script; an agent cannot mark a package valid.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const allowed = /\.(json|jpe?g|png|webp|avif|ktx2|glb|ply|spz|splat|ksplat|sog|rad|mp4|webm|m4a|mp3|ogg|wav)$/i;
const freeText = new Set(['text', 'secondaryText', 'title', 'description', 'caption', 'label', 'name', 'subtitle', 'titlePart1', 'titlePart2',
  'enterButtonText', 'exploreButtonText', 'loadingText', 'nextButtonText', 'previousButtonText', 'continueExploringButtonText', 'id', 'uuid']);

function sha256(file) {
  const hash = createHash('sha256');
  const handle = openSync(file, 'r');
  const buffer = Buffer.alloc(1 << 20);
  try { for (let read; (read = readSync(handle, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, read)); }
  finally { closeSync(handle); }
  return hash.digest('hex');
}

function files(folder, prefix = '') {
  return readdirSync(path.join(folder, prefix)).flatMap(name => {
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(path.join(folder, relative));
    return stat.isDirectory() && !stat.isSymbolicLink() ? files(folder, relative) : [relative];
  });
}

export function validatePackage(folder, expect = {}) {
  const errors = [], checks = {};
  const fail = message => { errors.push(message); };
  let manifest, bootstrap;
  try { manifest = JSON.parse(readFileSync(path.join(folder, 'manifest.json'), 'utf8')); } catch { fail('manifest.json is missing or not JSON.'); }
  try { bootstrap = JSON.parse(readFileSync(path.join(folder, 'bootstrap.json'), 'utf8')); } catch { fail('bootstrap.json is missing or not JSON.'); }
  if (!manifest || !bootstrap) return { passed: false, errors, checks };
  const real = realpathSync(folder);
  const slug = path.basename(folder);
  const datasetUrl = `/datasets/matterport/${slug}`;
  if (!/^[a-f0-9]{12}$/.test(manifest.sceneId ?? '')) fail('manifest.sceneId must be 12 hex characters.');
  if (manifest.slug !== slug) fail('manifest.slug must match the folder name.');
  if (manifest.datasetUrl !== datasetUrl || manifest.bootstrapUrl !== `${datasetUrl}/bootstrap.json`) fail('manifest URLs must point at this folder.');
  if (expect.sceneId && manifest.sceneId !== expect.sceneId) fail(`manifest.sceneId must be ${expect.sceneId}.`);
  if (expect.slug && slug !== expect.slug) fail(`The package folder must be ${expect.slug}.`);
  if (expect.title && manifest.title !== expect.title) fail('manifest.title must be the customer\'s title.');
  if (typeof manifest.title !== 'string' || !manifest.title.trim()) fail('manifest.title is required.');

  // Files: listed, hashed, typed, inside the folder.
  const listed = new Map();
  if (manifest.schema === 'sphr-package-v1') {
    if (!Array.isArray(manifest.files) || !manifest.files.length) fail('manifest.files must list the runtime files.');
    let total = 0;
    for (const item of manifest.files ?? []) {
      const name = item?.path;
      if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._/-]*$/i.test(name) || name.includes('..') || name.includes('//')) { fail(`Invalid file name: ${name}`); continue; }
      if (!allowed.test(name)) { fail(`File type not allowed: ${name}`); continue; }
      const file = path.join(folder, name);
      if (!existsSync(file) || lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile() || !realpathSync(file).startsWith(real + path.sep)) { fail(`Missing or linked file: ${name}`); continue; }
      const size = lstatSync(file).size;
      total += size;
      if (size !== item.bytes) fail(`Size changed: ${name}`);
      if (size > 4e9) fail(`File too large: ${name}`);
      if (sha256(file) !== item.sha256) fail(`Contents changed: ${name}`);
      listed.set(name, size);
    }
    if (total > 30e9) fail('The package is larger than 30 GB.');
    const extra = files(folder).filter(name => !listed.has(name) && !['manifest.json', 'validation.json'].includes(name));
    if (extra.length) fail(`Unlisted files: ${extra.slice(0, 10).join(', ')}`);
    for (const required of ['bootstrap.json', 'preview.jpg']) if (!listed.has(required)) fail(`${required} must be listed.`);
    checks.files = listed.size;
    checks.bytes = total;
  } else if (!['sphr-matterport-e57-v1', 'sphr-matterport-e57-v2', 'sphr-matterport-web-v1'].includes(manifest.schema)) {
    fail(`Unknown package schema: ${manifest.schema}`);
  }

  // Preview: a real JPEG of reasonable size.
  const preview = path.join(folder, 'preview.jpg');
  if (existsSync(preview)) {
    const head = readFileSync(preview).subarray(0, 3);
    if (head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) fail('preview.jpg is not a JPEG.');
    if (lstatSync(preview).size > 3e6) fail('preview.jpg is larger than 3 MB.');
  } else fail('preview.jpg is missing.');

  // Bootstrap: supported scene type, and every URL inside this package.
  const space = bootstrap.space;
  if (!space || typeof space.title !== 'string' || !['spaces', 'splat'].includes(space.type) || typeof space.space_data !== 'object') {
    fail('bootstrap.space needs a title, a type of "spaces" or "splat", and space_data.');
  }
  let urls = 0;
  const visit = (value, key, trail) => {
    if (typeof value === 'string') {
      if (freeText.has(key)) return;
      const looksLikeUrl = /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(value.trim());
      if (!looksLikeUrl) return;
      urls++;
      if (!value.startsWith(`${datasetUrl}/`)) { fail(`${trail} points outside the package: ${value.slice(0, 120)}`); return; }
      const relative = decodeURIComponent(value.slice(datasetUrl.length + 1)).split(/[?#]/)[0];
      if (relative.includes('..')) { fail(`${trail} climbs out of the package.`); return; }
      if (key === 'textureTemplate' || /\{[a-z]+\}/i.test(relative)) return;
      const known = manifest.schema === 'sphr-package-v1' ? listed.has(relative) : existsSync(path.join(folder, relative));
      if (!known) fail(`${trail} refers to a file that is not in the package: ${relative}`);
    } else if (Array.isArray(value)) value.forEach((item, index) => visit(item, key, `${trail}[${index}]`));
    else if (value && typeof value === 'object') for (const [name, item] of Object.entries(value)) visit(item, name, `${trail}.${name}`);
  };
  visit(bootstrap, '', 'bootstrap');
  checks.urls = urls;
  if (space?.type === 'spaces') {
    const nodes = space.space_data?.nodes ?? [];
    if (!nodes.length) fail('A panorama space needs at least one node.');
    if (nodes.some(node => typeof node.uuid !== 'string' || !node.position)) fail('Every node needs a uuid and a position.');
    checks.nodes = nodes.length;
  }
  if (space?.type === 'splat') {
    const splats = space.space_data?.splats ?? [];
    const models = (bootstrap.tour?.tour_data?.sceneGraph ?? space.space_data?.sceneGraph ?? []).filter(node => node.type === 'model');
    if (!splats.length && !models.length) fail('A splat space needs a splat or a model.');
    checks.splats = splats.length;
    checks.models = models.length;
  }
  return { passed: !errors.length, errors, checks };
}

// Compare real paths: temporary folders are often reached through symbolic links (macOS /var → /private/var).
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const folder = args.find(item => !item.startsWith('--'));
  const option = name => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
  if (!folder || !existsSync(folder)) { console.error('Usage: validate-package.mjs <package folder> [--scene-id ID] [--slug SLUG] [--title TITLE] [--write]'); process.exit(2); }
  const result = validatePackage(path.resolve(folder), { sceneId: option('scene-id'), slug: option('slug'), title: option('title') });
  const record = { ...result, validator: 'sphr-package-validate-v1', validatedAt: new Date().toISOString() };
  if (args.includes('--write')) writeFileSync(path.join(folder, 'validation.json'), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify(record, null, 2));
  process.exit(result.passed ? 0 : 1);
}
