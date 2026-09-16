import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { initializeAdmin, checkCredentials, createSession, validSession, deleteSession,
  changePassword, allowLogin, isScenePublic, setScenePublic } from '../lib/server/admin-store.ts';

const directory = mkdtempSync(path.join(tmpdir(), 'sphr-admin-test-'));
process.env.SPHR_STATE_DIR = directory;
process.env.SPHR_ACCESS_CONTROL = '1';
after(() => rmSync(directory, { recursive: true, force: true }));

test('hashed admin credentials, durable visibility, revocable sessions, and login throttling', async () => {
  await initializeAdmin('test-admin', 'initial-password');
  assert.equal(await checkCredentials('test-admin', 'initial-password'), true);
  assert.equal(await checkCredentials('unknown', 'initial-password'), false);
  assert.equal(await checkCredentials('test-admin', 'incorrect'), false);
  await assert.rejects(() => initializeAdmin('test-admin', 'replacement-password'));
  assert.equal(statSync(path.join(directory, 'admin.sqlite')).mode & 0o777, 0o600);

  const read = new DatabaseSync(path.join(directory, 'admin.sqlite'));
  assert.ok(!read.prepare('SELECT password FROM admin').get().password.includes('initial-password'));
  const session = createSession();
  assert.ok(validSession(session.token));
  assert.equal(validSession('invalid'), false);
  assert.notEqual(read.prepare('SELECT token FROM sessions').get().token, session.token);
  deleteSession(session.token);
  assert.equal(validSession(session.token), false);
  const expired = createSession();
  read.exec('UPDATE sessions SET expires=0');
  assert.equal(validSession(expired.token), false);

  const beforePasswordChange = createSession();
  assert.equal(await changePassword('incorrect', 'new-password'), false);
  assert.equal(await changePassword('initial-password', 'new-password'), true);
  assert.equal(validSession(beforePasswordChange.token), false);
  assert.equal(await checkCredentials('test-admin', 'initial-password'), false);
  assert.equal(await checkCredentials('test-admin', 'new-password'), true);

  const id = '0123456789ab';
  assert.equal(isScenePublic(id), false, 'unconfigured imports are private');
  setScenePublic(id, true);
  assert.equal(isScenePublic(id), true);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { isScenePublic } from './lib/server/admin-store.ts'; process.exit(isScenePublic('${id}') ? 0 : 1);`], { cwd: process.cwd(), env: process.env });
  assert.equal(child.status, 0, 'visibility survives reopening the database');
  setScenePublic(id, false);
  assert.equal(isScenePublic(id), false);
  assert.equal(read.prepare('SELECT count(*) AS n FROM audit').get().n, 2);
  for (let attempt = 0; attempt < 5; attempt++) assert.equal(allowLogin('test-client'), true);
  assert.equal(allowLogin('test-client'), false);
  assert.equal(allowLogin('different-client'), true);
  read.exec('UPDATE login_limits SET resets=0');
  assert.equal(allowLogin('test-client'), true);
  read.close();
});
