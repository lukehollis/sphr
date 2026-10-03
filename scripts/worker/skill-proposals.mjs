#!/usr/bin/env node
// Skills that processing agents propose after a job (output/skill-proposal/ in the job folder). The runner
// copies each proposal out of the job, checks it, has a second agent review it without the upload, and
// (with SPHR_SKILL_AUTOPROMOTE=1) promotes approved new skills into .agents/skills/, where every later job
// finds them. Changes to existing skills always wait for a person.
//   node scripts/worker/skill-proposals.mjs list
//   node scripts/worker/skill-proposals.mjs show <id>
//   node scripts/worker/skill-proposals.mjs promote <id> [--no-commit]
//   node scripts/worker/skill-proposals.mjs reject <id> [reason]
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const skillsRoot = path.resolve(process.env.SPHR_SKILLS_DIR?.trim() || path.join(root, '.agents/skills'));
export const proposalsRoot = () => path.resolve(process.env.SPHR_SKILL_PROPOSALS_DIR?.trim() || path.join(root, 'local/skill-proposals'));
const textFile = /\.(md|py|mjs|js|json|sh|txt|ya?ml)$/i;
const limits = { files: 40, fileBytes: 1_000_000, totalBytes: 4_000_000 };

function frontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  return Object.fromEntries(match[1].split(/\r?\n/).map(line => line.match(/^([A-Za-z_-]+):\s*(.*)$/)).filter(Boolean)
    .map(([, key, value]) => [key, value.trim().replace(/^["']|["']$/g, '')]));
}

function listFiles(dir, base = dir) {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    const info = lstatSync(full);
    if (info.isDirectory()) return listFiles(full, base);
    return [{ rel: path.relative(base, full), full, size: info.size, regular: info.isFile() }];
  });
}

/** Checks a proposal folder against the job it came from. Problems mean it must not reach later jobs. */
export function checkProposal(dir, job) {
  const problems = [];
  const files = listFiles(dir);
  if (files.length > limits.files) problems.push(`more than ${limits.files} files`);
  let total = 0, text = '';
  for (const file of files) {
    if (!file.regular) { problems.push(`${file.rel} is not a regular file`); continue; }
    if (!textFile.test(file.rel)) { problems.push(`${file.rel} is not a text file a skill may contain`); continue; }
    if (file.size > limits.fileBytes) problems.push(`${file.rel} is larger than 1 MB`);
    total += file.size;
    text += `\n${readFileSync(file.full, 'utf8')}`;
  }
  if (total > limits.totalBytes) problems.push('the proposal is larger than 4 MB');
  const skillFile = path.join(dir, 'SKILL.md');
  const head = existsSync(skillFile) ? frontmatter(readFileSync(skillFile, 'utf8')) : {};
  const name = head.name ?? '';
  const description = head.description ?? '';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) problems.push('SKILL.md needs a lowercase dashed name');
  if (description.length < 20 || description.length > 1024) problems.push('SKILL.md needs a description of 20–1024 characters');
  // Proposals are shared with every later customer's job, so nothing particular to this job may be in them.
  const needles = [[job.id, 'job ID'], [job.sceneId, 'scene ID'], [job.slug, 'storage slug'], [job.dir, 'job folder'],
    ...(job.title && job.title.trim().length >= 6 ? [[job.title.trim(), 'customer title']] : []),
    ...(job.files ?? []).filter(name => name.length >= 6).map(name => [name, 'uploaded file name'])];
  for (const [needle, label] of needles) if (needle && text.includes(needle)) problems.push(`it mentions this job's ${label}`);
  let proposal = {};
  try { proposal = JSON.parse(readFileSync(path.join(dir, 'proposal.json'), 'utf8')); } catch { problems.push('proposal.json is missing or not JSON'); }
  const exists = Boolean(name) && existsSync(path.join(skillsRoot, name));
  const kind = proposal.kind === 'update' || exists ? 'update' : 'new';
  return { ok: !problems.length, problems, name, description, kind, updates: String(proposal.updates ?? '').slice(0, 200),
    recognizes: String(proposal.recognizes ?? '').slice(0, 300), evidence: String(proposal.evidence ?? '').slice(0, 2000),
    files: files.map(file => file.rel) };
}

const readMeta = id => JSON.parse(readFileSync(path.join(proposalsRoot(), id, 'meta.json'), 'utf8'));
export function writeMeta(id, changes) {
  const meta = { ...readMeta(id), ...changes };
  writeFileSync(path.join(proposalsRoot(), id, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

/** Copies a job's proposal out of the job folder (job folders are scratch) and records the checks. */
export function storeProposal(source, job, outcome) {
  const checks = checkProposal(source, job);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const id = `${stamp}-${checks.name || 'unnamed'}-${job.id.slice(0, 8)}`;
  const dir = path.join(proposalsRoot(), id);
  mkdirSync(dir, { recursive: true });
  cpSync(source, path.join(dir, 'proposal'), { recursive: true, filter: file => !lstatSync(file).isSymbolicLink() });
  const meta = { id, name: checks.name, kind: checks.kind, description: checks.description, updates: checks.updates, recognizes: checks.recognizes,
    evidence: checks.evidence, files: checks.files, job: job.id, scene: job.sceneId, outcome, createdAt: new Date().toISOString(),
    checks: { ok: checks.ok, problems: checks.problems }, status: checks.ok ? 'pending' : 'rejected' };
  writeFileSync(path.join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  return { id, dir, meta };
}

/** Installs a proposal as .agents/skills/<name>/ (keeping the replaced version in the proposal folder) and commits it. */
export function promote(id, { commit = true, by = 'operator' } = {}) {
  const meta = readMeta(id);
  if (!meta.checks?.ok) throw new Error(`Proposal ${id} failed its checks: ${meta.checks?.problems?.join('; ')}`);
  if (meta.status === 'promoted') throw new Error(`Proposal ${id} is already promoted.`);
  const source = path.join(proposalsRoot(), id, 'proposal');
  const target = path.join(skillsRoot, meta.name);
  if (existsSync(target)) {
    const previous = path.join(proposalsRoot(), id, 'replaced');
    rmSync(previous, { recursive: true, force: true });
    renameSync(target, previous);
  }
  cpSync(source, target, { recursive: true, filter: file => path.basename(file) !== 'proposal.json' });
  const skill = path.join(target, 'SKILL.md');
  const learned = `learned: ${new Date().toISOString().slice(0, 10)} from processing job ${meta.job}, reviewed (${by})`;
  writeFileSync(skill, readFileSync(skill, 'utf8').replace(/^(---\r?\n[\s\S]*?)(\r?\n---)/, (all, top, end) =>
    `${top.split(/\r?\n/).filter(line => !line.startsWith('learned:')).join('\n')}\n${learned}${end}`));
  let hash = null;
  const relative = path.relative(root, target);
  if (commit && spawnSync('git', ['-C', root, 'rev-parse', '--git-dir'], { encoding: 'utf8' }).status === 0) {
    spawnSync('git', ['-C', root, 'add', '--all', '--', relative], { encoding: 'utf8' });
    const done = spawnSync('git', ['-C', root, 'commit', '-q', '-m', `Learn the ${meta.name} skill from processing job ${meta.job}\n\n${meta.description}\n\nProposed by the processing agent; ${meta.review?.summary ? `reviewer: ${meta.review.summary}` : `promoted by the ${by}`}.`, '--', relative], { encoding: 'utf8' });
    if (done.status === 0) hash = spawnSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  }
  writeMeta(id, { status: 'promoted', promotedAt: new Date().toISOString(), promotedBy: by, commit: hash });
  return { name: meta.name, target, commit: hash };
}

export function reject(id, reason = 'rejected by the operator') {
  return writeMeta(id, { status: 'rejected', rejectedAt: new Date().toISOString(), reason });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command = 'list', id, ...rest] = process.argv.slice(2);
  const all = () => existsSync(proposalsRoot()) ? readdirSync(proposalsRoot()).filter(name => existsSync(path.join(proposalsRoot(), name, 'meta.json'))).sort() : [];
  if (command === 'list') {
    for (const name of all()) {
      const meta = readMeta(name);
      console.log(`${meta.status.padEnd(9)} ${meta.kind.padEnd(6)} ${name}\n          ${meta.review?.summary || meta.description}${meta.checks.ok ? '' : `\n          checks: ${meta.checks.problems.join('; ')}`}`);
    }
    if (!all().length) console.log('No skill proposals yet.');
  } else if (command === 'show' && id) {
    const dir = path.join(proposalsRoot(), id);
    console.log(JSON.stringify(readMeta(id), null, 2));
    for (const file of listFiles(path.join(dir, 'proposal'))) console.log(`\n===== ${file.rel} (${statSync(file.full).size} bytes) =====\n${readFileSync(file.full, 'utf8')}`);
  } else if (command === 'promote' && id) {
    const done = promote(id, { commit: !rest.includes('--no-commit') });
    console.log(`Promoted ${done.name} to ${done.target}${done.commit ? ` (commit ${done.commit})` : ''}.`);
  } else if (command === 'reject' && id) {
    reject(id, rest.join(' ') || undefined);
    console.log(`Rejected ${id}.`);
  } else {
    console.error('Usage: skill-proposals.mjs list | show <id> | promote <id> [--no-commit] | reject <id> [reason]');
    process.exit(1);
  }
}
