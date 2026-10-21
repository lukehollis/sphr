// A job's agent controls its folder; the runner's reads must never follow it to files elsewhere on the worker.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readJobFile } from './worker/job-files.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'sphr-jobfiles-'));
const secret = path.join(root, 'secret.env');
writeFileSync(secret, 'WORKER_TOKEN=do-not-leak\n');
const job = path.join(root, 'job');
mkdirSync(path.join(job, 'output'), { recursive: true });

test('reads a regular file the agent wrote', () => {
  writeFileSync(path.join(job, 'output/result.json'), '{"status":"ready"}');
  assert.equal(readJobFile(job, 'output/result.json'), '{"status":"ready"}');
});

test('refuses a file that is a symlink to a secret', () => {
  symlinkSync(secret, path.join(job, 'output/progress.log'));
  assert.throws(() => readJobFile(job, 'output/progress.log', { tail: true }));
});

test('refuses a file reached through a linked folder', () => {
  mkdirSync(path.join(root, 'elsewhere'));
  writeFileSync(path.join(root, 'elsewhere/result.json'), 'WORKER_TOKEN=do-not-leak');
  symlinkSync(path.join(root, 'elsewhere'), path.join(job, 'linked'));
  assert.throws(() => readJobFile(job, 'linked/result.json'), /outside the job folder/);
});

test('caps what it reads', () => {
  writeFileSync(path.join(job, 'output/big.log'), `${'x'.repeat(5000)}\nlast line`);
  assert.throws(() => readJobFile(job, 'output/big.log', { maxBytes: 100 }), /too large/);
  assert.equal(readJobFile(job, 'output/big.log', { maxBytes: 9, tail: true }), 'last line');
});
