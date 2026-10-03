#!/usr/bin/env node
// Turn asset packs (zips of FBX or OBJ props sharing a color atlas) into a model
// library for the tour builder: one Draco GLB and one thumbnail per prop, plus
// index.json in the format of lib/experience/library.ts.
//
//   node scripts/library/import-packs.mjs local/library/packs.json
//
// packs.json lists packs with their zip, atlas path inside the zip, license scope
// and the props to take (file name prefixes). Keep it out of Git: it names local
// files and licensed assets.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const configPath = process.argv[2];
if (!configPath) { console.error('Usage: node scripts/library/import-packs.mjs <packs.json>'); process.exit(1); }
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const out = path.resolve(config.out ?? 'local/library');
const blender = config.blender ?? process.env.BLENDER ?? '/Applications/Blender.app/Contents/MacOS/Blender';
const work = path.join(out, '.work');
const script = path.join(path.dirname(new URL(import.meta.url).pathname), 'blender_convert.py');
mkdirSync(work, { recursive: true });

const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function prettyName(file) {
  return path.basename(file).replace(/\.(fbx|obj)$/i, '')
    .replace(/^(SM|SK|SO|ST)_/, '').replace(/^(Icon|Item|Prop|Env|Veh|Chr)_/, '').replace(/^(Item|Prop|Chr)_/, '')
    .replace(/_0?1$/, '').replace(/_(\d+)$/, ' $1').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim();
}

const existing = existsSync(path.join(out, 'index.json')) ? JSON.parse(readFileSync(path.join(out, 'index.json'), 'utf8')).models ?? [] : [];
const models = new Map(existing.map((model) => [model.id, model]));

for (const pack of config.packs) {
  const entries = execFileSync('unzip', ['-Z1', pack.zip], { maxBuffer: 64 * 1024 * 1024 }).toString().split('\n').filter(Boolean);
  const chosen = new Map();
  for (const item of pack.items) {
    const spec = typeof item === 'string' ? { match: item } : item;
    const candidates = entries.filter((entry) => /\.(fbx|obj)$/i.test(entry) && path.basename(entry).replace(/\.(fbx|obj)$/i, '') === spec.match)
      .sort((a, b) => Number(/\.fbx$/i.test(b)) - Number(/\.fbx$/i.test(a)) || Number(/\/FBX\//i.test(b)) - Number(/\/FBX\//i.test(a)) || a.length - b.length);
    if (!candidates.length) { console.warn(`  ${pack.id}: no file for ${spec.match}`); continue; }
    chosen.set(spec.match, { ...spec, entry: candidates[0] });
  }
  const packDir = path.join(work, pack.id);
  rmSync(packDir, { recursive: true, force: true });
  mkdirSync(packDir, { recursive: true });
  execFileSync('unzip', ['-q', '-o', '-j', pack.zip, pack.atlas, ...[...chosen.values()].map((item) => item.entry), '-d', packDir], { maxBuffer: 64 * 1024 * 1024 });
  const atlas = path.join(packDir, path.basename(pack.atlas));
  const jobs = { atlas, atlas_size: pack.atlasSize ?? 512, items: [...chosen.values()].map((item) => {
    const id = `${pack.id}-${slug(item.match)}`;
    return { id, source: path.join(packDir, path.basename(item.entry)), glb: path.join(out, pack.id, `${slug(item.match)}.glb`), thumb: path.join(packDir, `${slug(item.match)}.png`), spec: item };
  }) };
  writeFileSync(path.join(packDir, 'jobs.json'), JSON.stringify(jobs, null, 1));
  console.log(`${pack.id}: converting ${jobs.items.length} props in Blender`);
  execFileSync(blender, ['-b', '--factory-startup', '--python', script, '--', path.join(packDir, 'jobs.json')], { stdio: ['ignore', 'ignore', 'inherit'], maxBuffer: 256 * 1024 * 1024 });
  const results = JSON.parse(readFileSync(path.join(packDir, 'results.json'), 'utf8'));
  for (const [index, result] of results.entries()) {
    const job = jobs.items[index];
    if (!result.ok) { console.warn(`  ${job.spec.match}: ${result.error}`); continue; }
    const thumbnail = path.join(out, pack.id, `${slug(job.spec.match)}.webp`);
    await sharp(result.thumb).webp({ quality: 82 }).toFile(thumbnail);
    const category = job.spec.category ?? (pack.categories ?? []).find((rule) => new RegExp(rule.pattern, 'i').test(job.spec.match))?.category ?? pack.category ?? 'Props';
    models.set(job.id, {
      id: job.id,
      name: job.spec.name ?? prettyName(job.spec.match),
      category,
      url: `${pack.id}/${slug(job.spec.match)}.glb`,
      thumbnail: `${pack.id}/${slug(job.spec.match)}.webp`,
      height: result.height,
      tags: job.spec.tags ?? [],
      pack: pack.label,
      scope: pack.scope ?? 'team'
    });
  }
}

const list = [...models.values()].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
writeFileSync(path.join(out, 'index.json'), JSON.stringify({ models: list }, null, 1));
rmSync(work, { recursive: true, force: true });
console.log(`${list.length} models in ${path.join(out, 'index.json')}`);
