import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import sharp from 'sharp';

// Resolve the app's extensionless TypeScript imports the way Next does.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@/')) return next(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context);
    if (/^\.\.?\//.test(specifier) && context.parentURL?.endsWith('.ts') && !/\.[a-z]+$/.test(specifier)) return next(`${specifier}.ts`, context);
    if (/^next\/[a-z-]+$/.test(specifier)) return next(`${specifier}.js`, context);
    return next(specifier, context);
  }
});

const directory = mkdtempSync(path.join(tmpdir(), 'sphr-social-test-'));
Object.assign(process.env, { SPHR_STATE_DIR: directory, SPHR_ACCESS_CONTROL: '1', SPHR_ACCOUNTS: '1' });
after(() => rmSync(directory, { recursive: true, force: true }));

const { parseSpaceInfo, SpaceInfoError, contactHref, formatCapturedOn } = await import('../lib/space-info.ts');
const info = await import('../lib/server/space-info.ts');
const profiles = await import('../lib/server/profiles.ts');
const accounts = await import('../lib/server/accounts-store.ts');
const { EditConflict } = await import('../lib/server/admin-store.ts');

test('space details keep what is filled in and refuse what is not a date, contact or website', () => {
  assert.deepEqual(parseSpaceInfo({ description: '  A tomb.\n\n\n\nDeep. ', location: '', website: 'example.com/a', contact: 'hi@example.com' }),
    { description: 'A tomb.\n\nDeep.', website: 'https://example.com/a', contact: 'hi@example.com' });
  for (const bad of [{ capturedOn: '2023-13-01' }, { contact: 'not an address' }, { website: 'nowhere' }, { location: 'x'.repeat(201) }, { location: 4 }]) {
    assert.throws(() => parseSpaceInfo(bad), SpaceInfoError);
  }
  assert.equal(contactHref('https://example.com/contact'), 'https://example.com/contact');
  assert.equal(formatCapturedOn('2023'), '2023');
});

test('space details save by revision', () => {
  const saved = info.saveSpaceInfo('aaaaaaaaaaaa', 0, { location: 'Luxor' });
  assert.equal(saved.revision, 1);
  assert.deepEqual(info.readSpaceInfo('aaaaaaaaaaaa'), { info: { location: 'Luxor' }, revision: 1 });
  assert.throws(() => info.saveSpaceInfo('aaaaaaaaaaaa', 0, {}), EditConflict);
});

test('profiles start neutral, take a unique handle, and follow and heart', async () => {
  const a = accounts.signInWithIdentity({ provider: 'google', label: 'Google', subject: 'a', email: 'a@example.com', emailVerified: true, name: 'Real Name' });
  const b = accounts.signInWithIdentity({ provider: 'google', label: 'Google', subject: 'b', email: 'b@example.com', emailVerified: true, name: 'Other' });
  const userA = a.user ?? a, userB = b.user ?? b;
  const first = profiles.ensureProfile(userA.id);
  assert.match(first.handle, /^member-[a-f0-9]{6,}$/);
  assert.equal(first.name, null, 'nothing personal is published until its owner chooses');
  const updated = profiles.updateProfile(userA.id, { handle: '@Ada.Maker', name: ' Ada ', website: 'ada.example', bio: 'Hi\n\n\n\nthere' });
  assert.deepEqual([updated.handle, updated.name, updated.website, updated.bio], ['ada.maker', 'Ada', 'https://ada.example/', 'Hi\n\nthere']);
  assert.equal(profiles.readProfileByHandle('ADA.MAKER')?.userId, userA.id);
  assert.throws(() => profiles.updateProfile(userB.id, { handle: 'ada.maker' }), profiles.ProfileError);
  for (const handle of ['ad', 'admin', 'a..b', '-ada', 'x'.repeat(31)]) assert.throws(() => profiles.updateProfile(userB.id, { handle }), profiles.ProfileError);

  profiles.setFollowing(userB.id, userA.id, true);
  profiles.setFollowing(userB.id, userA.id, true);
  assert.deepEqual(profiles.followCounts(userA.id), { followers: 1, following: 0 });
  assert.equal(profiles.isFollowing(userB.id, userA.id), true);
  assert.throws(() => profiles.setFollowing(userA.id, userA.id, true), profiles.ProfileError);
  profiles.setFollowing(userB.id, userA.id, false);
  assert.equal(profiles.followCounts(userA.id).followers, 0);

  assert.equal(profiles.setHeart(userB.id, 'bbbbbbbbbbbb', true), 1);
  assert.equal(profiles.setHeart(userB.id, 'bbbbbbbbbbbb', true), 1);
  assert.equal(profiles.hasHeart(userB.id, 'bbbbbbbbbbbb'), true);
  assert.equal(profiles.setHeart(userB.id, 'bbbbbbbbbbbb', false), 0);

  const photo = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#884422' } }).jpeg().toBuffer();
  const url = await profiles.saveProfileImage(userA.id, 'avatar', photo);
  assert.match(url, new RegExp(`^/api/profile-files/${userA.id}/avatar-[a-f0-9]{16}\\.webp$`));
  const stored = profiles.profileImageFile(userA.id, url.split('/').pop());
  assert.deepEqual(await sharp(stored).metadata().then(meta => [meta.format, meta.width, meta.height]), ['webp', 512, 512]);
  await assert.rejects(profiles.saveProfileImage(userA.id, 'cover', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), profiles.ProfileError);
  profiles.removeProfileImage(userA.id, 'avatar');
  assert.equal(profiles.profileImageFile(userA.id, url.split('/').pop()), null);
  assert.equal(profiles.profileImageFile('../etc', 'avatar-0000000000000000.webp'), null);
});
