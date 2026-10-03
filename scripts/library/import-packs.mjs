#!/usr/bin/env node
// Turn asset packs into a model library for the tour builder: one Draco GLB and
// one thumbnail per prop, plus index.json in the format of lib/experience/library.ts.
// Packs are zips of FBX or OBJ props sharing a color atlas (Synty), or of glTF/GLB
// props that bring their own materials (Kenney, Quaternius).
//
//   node scripts/library/import-packs.mjs local/library/packs.json [pack-id,...]
//
// packs.json lists packs with their zip, atlas path inside the zip (FBX/OBJ packs),
// license scope, credit and the props to take: file names without extension, or
// { match, id, name, category, tags, height, rotate, keep, atlas } where height is the
// prop's real height in meters. `keep` picks one object out of a file that holds many
// (by name), `atlas` gives that item its own texture, and `id` tells apart items
// taken from the same file. { pattern, exclude, ... } takes every matching file name;
// a pack's `folder` limits the search to paths matching it. A pack's `format` picks glb or gltf sources, and `scale` resizes props
// with no height. Keep it out of Git: it names local files and licensed assets.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const configPath = process.argv[2];
if (!configPath) { console.error('Usage: node scripts/library/import-packs.mjs <packs.json> [pack-id,...]'); process.exit(1); }
// Optional pack IDs convert only those packs and keep every other pack's models as they are.
const only = process.argv[3]?.split(',').filter(Boolean);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const out = path.resolve(config.out ?? 'local/library');
const blender = config.blender ?? process.env.BLENDER ?? '/Applications/Blender.app/Contents/MacOS/Blender';
const work = path.join(out, '.work');
const script = path.join(path.dirname(new URL(import.meta.url).pathname), 'blender_convert.py');
mkdirSync(work, { recursive: true });

const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const modelFile = /\.(fbx|obj|glb|gltf)$/i;
function prettyName(file, strip) {
  return path.basename(file).replace(modelFile, '').replace(strip ? new RegExp(strip) : /^$/, '')
    .replace(/_0*1A$/, '').replace(/_0*(\d+)([A-Z])$/, (_, number, letter) => ` ${number}${letter.toLowerCase()}`)
    .replace(/^(SM|SK|SO|ST)_/, '').replace(/^(Icon|Item|Prop|Env|Veh|Chr)_/, '').replace(/^(Item|Prop|Chr)_/, '')
    .replace(/_0*1$/, '').replace(/_0*(\d+)$/, ' $1').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim();
}

const existing = existsSync(path.join(out, 'index.json')) ? JSON.parse(readFileSync(path.join(out, 'index.json'), 'utf8')).models ?? [] : [];
const models = new Map(existing.map((model) => [model.id, model]));

for (const pack of config.packs.filter((item) => !only || only.includes(item.id))) {
  for (const id of models.keys()) if (id.startsWith(`${pack.id}-`)) models.delete(id);
  const entries = execFileSync('unzip', ['-Z1', pack.zip], { maxBuffer: 64 * 1024 * 1024 }).toString().split('\n').filter(Boolean);
  const chosen = new Map();
  // glTF packs keep their own materials; the rest share the pack's atlas.
  const gltf = /^(glb|gltf)$/i.test(pack.format ?? '');
  const extension = gltf ? new RegExp(`\\.${pack.format}$`, 'i') : /\.(fbx|obj)$/i;
  // { pattern, exclude } entries take every model file whose name matches, sharing the entry's other fields.
  const inFolder = (entry, folder) => extension.test(entry) && new RegExp(folder ?? pack.folder ?? '.', 'i').test(entry);
  const specs = pack.items.flatMap((item) => {
    if (typeof item === 'string') return [{ match: item }];
    if (!item.pattern) return [item];
    const { pattern, exclude, ...rest } = item;
    const names = [...new Set(entries.filter((entry) => inFolder(entry, item.folder)).map((entry) => path.basename(entry).replace(modelFile, '')))].sort();
    return names.filter((name) => new RegExp(pattern).test(name) && !(exclude && new RegExp(exclude).test(name))).map((match) => ({ ...rest, match }));
  });
  for (const spec of specs) {
    const candidates = entries.filter((entry) => inFolder(entry, spec.folder) && path.basename(entry).replace(modelFile, '') === spec.match)
      .sort((a, b) => Number(/\.fbx$/i.test(b)) - Number(/\.fbx$/i.test(a)) || Number(/\/FBX\//i.test(b)) - Number(/\/FBX\//i.test(a)) || a.length - b.length);
    if (!candidates.length) { console.warn(`  ${pack.id}: no file for ${spec.match}`); continue; }
    chosen.set(spec.id ?? spec.match, { ...spec, entry: candidates[0] });
  }
  const packDir = path.join(work, pack.id);
  rmSync(packDir, { recursive: true, force: true });
  mkdirSync(packDir, { recursive: true });
  const sources = [...new Set([...chosen.values()].map((item) => item.entry))];
  const itemAtlases = [...new Set([...chosen.values()].flatMap((item) => item.atlas ? [item.atlas] : []))];
  // A .gltf names its .bin and textures by bare file name or under Textures/; extract both ways.
  const extras = gltf ? [...sources.filter((entry) => /\.gltf$/i.test(entry)).map((entry) => entry.replace(/\.gltf$/i, '.bin')).filter((entry) => entries.includes(entry)),
    ...entries.filter((entry) => /\.(png|jpe?g)$/i.test(entry) && new RegExp(pack.textures ?? '.', 'i').test(entry))] : [pack.atlas];
  execFileSync('unzip', ['-q', '-o', '-j', pack.zip, ...extras, ...itemAtlases, ...sources, '-d', packDir], { maxBuffer: 64 * 1024 * 1024 });
  if (gltf) {
    mkdirSync(path.join(packDir, 'Textures'), { recursive: true });
    for (const entry of extras.filter((name) => /\.(png|jpe?g)$/i.test(name))) cpSync(path.join(packDir, path.basename(entry)), path.join(packDir, 'Textures', path.basename(entry)));
  }
  const atlas = gltf ? null : path.join(packDir, path.basename(pack.atlas));
  const jobs = { atlas, atlas_size: pack.atlasSize ?? 512, scale: pack.scale ?? null, image_format: pack.imageFormat ?? 'JPEG', max_height: pack.maxHeight ?? 30, items: [...chosen.values()].map((item) => {
    const name = slug(item.id ?? item.match);
    return { id: `${pack.id}-${name}`, name, source: path.join(packDir, path.basename(item.entry)), glb: path.join(out, pack.id, `${name}.glb`),
      thumb: path.join(packDir, `${name}.png`), atlas: item.atlas ? path.join(packDir, path.basename(item.atlas)) : null, spec: item };
  }) };
  writeFileSync(path.join(packDir, 'jobs.json'), JSON.stringify(jobs, null, 1));
  console.log(`${pack.id}: converting ${jobs.items.length} props in Blender`);
  execFileSync(blender, ['-b', '--factory-startup', '--python', script, '--', path.join(packDir, 'jobs.json')], { stdio: ['ignore', 'ignore', 'inherit'], maxBuffer: 256 * 1024 * 1024 });
  const results = JSON.parse(readFileSync(path.join(packDir, 'results.json'), 'utf8'));
  for (const [index, result] of results.entries()) {
    const job = jobs.items[index];
    if (!result.ok) { console.warn(`  ${job.spec.match}: ${result.error}`); continue; }
    // Parts of a few files carry their own unit scale and come out a hundred times too big.
    if (!job.spec.height && result.height > (pack.maxHeight ?? 30) * 1.5) {
      console.warn(`  ${job.spec.match}: skipped, ${result.height} m tall`);
      rmSync(job.glb, { force: true });
      continue;
    }
    const thumbnail = path.join(out, pack.id, `${job.name}.webp`);
    await sharp(result.thumb).webp({ quality: 82 }).toFile(thumbnail);
    const category = job.spec.category ?? (pack.categories ?? []).find((rule) => new RegExp(rule.pattern, 'i').test(job.spec.match))?.category ?? pack.category ?? 'Props';
    models.set(job.id, {
      id: job.id,
      name: job.spec.name ?? prettyName(job.spec.match, job.spec.stripName ?? pack.stripName),
      category,
      url: `${pack.id}/${job.name}.glb`,
      thumbnail: `${pack.id}/${job.name}.webp`,
      height: result.height,
      tags: job.spec.tags ?? pack.tags ?? [],
      pack: pack.label,
      ...(pack.credit ? { credit: pack.credit } : {}),
      scope: pack.scope ?? 'team'
    });
  }
}

const list = [...models.values()].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
writeFileSync(path.join(out, 'index.json'), JSON.stringify({ models: list }, null, 1));
rmSync(work, { recursive: true, force: true });
console.log(`${list.length} models in ${path.join(out, 'index.json')}`);
