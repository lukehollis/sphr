// Skill proposals from processing jobs: what may reach later jobs, and how promotion installs a skill.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const scratch = mkdtempSync(path.join(tmpdir(), 'sphr-skills-'));
process.env.SPHR_SKILL_PROPOSALS_DIR = path.join(scratch, 'proposals');
process.env.SPHR_SKILLS_DIR = path.join(scratch, 'skills');
mkdirSync(path.join(scratch, 'skills/sphr-intake'), { recursive: true });
writeFileSync(path.join(scratch, 'skills/sphr-intake/SKILL.md'), '---\nname: sphr-intake\ndescription: existing\n---\n');
const { canAutoPromote, checkProposal, storeProposal, promote, reject } = await import('./worker/skill-proposals.mjs');

const job = { id: 'abcdef0123456789', sceneId: '0123456789ab', slug: 'customer-fedcba987654', dir: '/jobs/abcdef0123456789',
  title: 'Riverside studio', files: ['studio_capture_07.zip'] };

function proposal(name, files) {
  const dir = path.join(scratch, 'source', name);
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(path.join(dir, file), text);
  return dir;
}
const skill = (name, body = 'Stitch rotate-in-place phone captures into a panorama.') =>
  `---\nname: ${name}\ndescription: Phone captures taken turning in place, with per-frame rotations, become a 360 panorama.\n---\n\n${body}\n`;
const json = (kind = 'new') => JSON.stringify({ name: 'x', kind, recognizes: 'frames with zero translation', evidence: 'built and validated' });

test('a general proposal passes and is a new skill', () => {
  const dir = proposal('good', { 'SKILL.md': skill('capture-phone-sphere'), 'scripts/stitch.py': 'print(1)\n', 'proposal.json': json() });
  const checks = checkProposal(dir, job);
  assert.equal(checks.ok, true, checks.problems.join('; '));
  assert.equal(checks.kind, 'new');
  assert.deepEqual(checks.files.sort(), ['SKILL.md', 'proposal.json', 'scripts/stitch.py']);
});

test('anything particular to the job keeps a proposal from later jobs', () => {
  const dir = proposal('leaky', { 'SKILL.md': skill('capture-leaky', 'Built Riverside studio from studio_capture_07.zip in /jobs/abcdef0123456789.'), 'proposal.json': json() });
  const { ok, problems } = checkProposal(dir, job);
  assert.equal(ok, false);
  for (const label of ['customer title', 'uploaded file name', 'job folder', 'job ID']) assert.ok(problems.some(p => p.includes(label)), label);
});

test('names, descriptions, file types and links are checked', () => {
  const dir = proposal('bad', { 'SKILL.md': '---\nname: Bad Name\ndescription: short\n---\n', 'scripts/tool.bin': 'x', 'proposal.json': json() });
  symlinkSync('/etc/passwd', path.join(dir, 'scripts/link.py'));
  const { ok, problems } = checkProposal(dir, job);
  assert.equal(ok, false);
  for (const fragment of ['lowercase dashed name', 'description', 'tool.bin is not a text file', 'link.py is not a regular file']) {
    assert.ok(problems.some(p => p.includes(fragment)), fragment);
  }
});

test('a proposal named like an existing skill is an update', () => {
  const dir = proposal('update', { 'SKILL.md': skill('sphr-intake'), 'proposal.json': json('new') });
  assert.equal(checkProposal(dir, job).kind, 'update');
});

test('promotion installs the skill, marks it learned and keeps what it replaced', () => {
  const dir = proposal('promote', { 'SKILL.md': skill('capture-phone-sphere'), 'scripts/stitch.py': 'print(2)\n', 'proposal.json': json() });
  const stored = storeProposal(dir, job, 'done');
  assert.equal(stored.meta.status, 'pending');
  assert.ok(existsSync(path.join(stored.dir, 'proposal/scripts/stitch.py')), 'copied out of the job folder');
  const done = promote(stored.id, { commit: false, by: 'test' });
  const installed = path.join(scratch, 'skills/capture-phone-sphere');
  assert.equal(done.target, installed);
  assert.deepEqual(readdirSync(installed).sort(), ['SKILL.md', 'scripts'], 'proposal.json stays behind');
  const text = readFileSync(path.join(installed, 'SKILL.md'), 'utf8');
  assert.match(text, /^---\nname: capture-phone-sphere\n.*\nlearned: \d{4}-\d{2}-\d{2} from processing job abcdef0123456789, reviewed \(test\)\n---/s);
  assert.throws(() => promote(stored.id, { commit: false }), /already promoted/);
  // A second version replaces the first and keeps it in its proposal folder.
  const again = storeProposal(proposal('promote-2', { 'SKILL.md': skill('capture-phone-sphere', 'Version two.'), 'proposal.json': json('update') }), job, 'done');
  assert.equal(again.meta.kind, 'update');
  promote(again.id, { commit: false, by: 'test' });
  assert.match(readFileSync(path.join(installed, 'SKILL.md'), 'utf8'), /Version two/);
  assert.match(readFileSync(path.join(again.dir, 'replaced/SKILL.md'), 'utf8'), /Stitch rotate-in-place/);
});

test('a proposal that failed its checks cannot be promoted, and can be rejected', () => {
  const stored = storeProposal(proposal('blocked', { 'SKILL.md': skill('capture-blocked', 'See studio_capture_07.zip'), 'proposal.json': json() }), job, 'done');
  assert.equal(stored.meta.status, 'rejected');
  assert.throws(() => promote(stored.id, { commit: false }), /failed its checks/);
  assert.equal(reject(stored.id, 'not general').status, 'rejected');
});

test('only reviewed new skills promote themselves, and tools only after a job published', () => {
  const base = { status: 'approved', kind: 'new', checks: { ok: true } };
  const knowledge = { ...base, files: ['SKILL.md', 'proposal.json'] };
  const tools = { ...base, files: ['SKILL.md', 'proposal.json', 'scripts/stitch.py'] };
  assert.equal(canAutoPromote(knowledge, 'held'), true, 'knowledge from a held job');
  assert.equal(canAutoPromote(tools, 'held'), false, 'unproven tools wait');
  assert.equal(canAutoPromote(tools, 'done'), true, 'tools from a published job');
  assert.equal(canAutoPromote({ ...tools, kind: 'update' }, 'done'), false, 'corrections wait for a person');
  assert.equal(canAutoPromote({ ...knowledge, status: 'pending' }, 'done'), false, 'unreviewed');
  assert.equal(canAutoPromote({ ...knowledge, checks: { ok: false } }, 'done'), false, 'failed checks');
});
