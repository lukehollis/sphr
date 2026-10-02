import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, createVerify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fakeStripe, listen } from './test-support/fake-services.mjs';

// Resolve the app's extensionless TypeScript imports the way Next does.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@/')) return next(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context);
    if (/^\.\.?\//.test(specifier) && context.parentURL?.endsWith('.ts') && !/\.[a-z]+$/.test(specifier)) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  }
});

const directory = mkdtempSync(path.join(tmpdir(), 'sphr-accounts-test-'));
Object.assign(process.env, { SPHR_STATE_DIR: directory, SPHR_ACCESS_CONTROL: '1', SPHR_ACCOUNTS: '1' });
after(() => rmSync(directory, { recursive: true, force: true }));

const store = await import('../lib/server/accounts-store.ts');
const { allowAttempt } = await import('../lib/server/admin-store.ts');


test('password accounts: hashing, sessions, single-use tokens and resets', async () => {
  const user = await store.createPasswordUser(' Person@Example.com ', 'correct horse', 'Pat  Example');
  assert.equal(user.email, 'person@example.com');
  assert.equal(user.name, 'Pat Example');
  assert.equal(user.emailVerified, false);
  await assert.rejects(() => store.createPasswordUser('person@example.com', 'another password', null), /already exists/);
  await assert.rejects(() => store.createPasswordUser('not-an-email', 'correct horse', null), /valid email/);
  await assert.rejects(() => store.createPasswordUser('short@example.com', 'short', null), /8–256/);
  assert.equal((await store.checkUserPassword('PERSON@example.com', 'correct horse'))?.id, user.id);
  assert.equal(await store.checkUserPassword('person@example.com', 'wrong password'), undefined);
  assert.equal(await store.checkUserPassword('nobody@example.com', 'correct horse'), undefined);

  const session = store.createUserSession(user.id);
  assert.equal(store.userFromSession(session.token)?.id, user.id);
  assert.equal(store.userFromSession('0'.repeat(64)), undefined);
  assert.equal(store.userFromSession('not a token'), undefined);

  const verify = store.createUserToken(user.id, 'verify', 60000);
  assert.equal(store.consumeUserToken(verify, 'reset'), undefined, 'purpose is enforced');
  const again = store.createUserToken(user.id, 'verify', 60000);
  assert.equal(store.consumeUserToken(verify, 'verify'), undefined, 'a newer link replaces an older one');
  assert.equal(store.consumeUserToken(again, 'verify'), user.id);
  assert.equal(store.consumeUserToken(again, 'verify'), undefined, 'links work once');
  store.markEmailVerified(user.id);
  assert.equal(store.readUser(user.id).emailVerified, true);

  const reset = store.createUserToken(user.id, 'reset', 60000);
  assert.equal(store.consumeUserToken(reset, 'reset'), user.id);
  await store.resetUserPassword(user.id, 'new password here');
  assert.equal(store.userFromSession(session.token), undefined, 'a reset signs out every session');
  assert.ok(await store.checkUserPassword('person@example.com', 'new password here'));
  const expired = store.createUserToken(user.id, 'reset', -1);
  assert.equal(store.consumeUserToken(expired, 'reset'), undefined);
});

test('identity sign-in links verified email and removes unverified passwords', async () => {
  const google = { provider: 'google', label: 'Google', subject: 'g-1', email: 'new@example.com', emailVerified: true, name: 'New Person' };
  const { user: created } = store.signInWithIdentity(google);
  assert.deepEqual(created.providers, ['google']);
  assert.equal(created.emailVerified, true);
  assert.equal(store.signInWithIdentity(google).user.id, created.id, 'the same identity signs in again');
  assert.equal(store.signInWithIdentity({ ...google, provider: 'linkedin', subject: 'l-1', email: 'NEW@example.com' }).user.id, created.id);
  assert.throws(() => store.signInWithIdentity({ ...google, subject: 'g-2', email: 'other@example.com', emailVerified: false }), /verified email/);
  assert.throws(() => store.signInWithIdentity({ ...google, subject: 'g-3', email: undefined }), /verified email/);

  // Someone registers a victim's address with a password but cannot confirm it.
  const squatter = await store.createPasswordUser('victim@example.com', 'squatter password', null);
  const squatterSession = store.createUserSession(squatter.id);
  const { user: owner, passwordRemoved } = store.signInWithIdentity({ provider: 'apple', label: 'Apple', subject: 'a-1', email: 'victim@example.com', emailVerified: true });
  assert.equal(passwordRemoved, true);
  assert.equal(owner.id, squatter.id);
  assert.equal(owner.hasPassword, false, 'the unverified password is removed');
  assert.equal(owner.emailVerified, true);
  assert.equal(store.userFromSession(squatterSession.token), undefined, 'the squatter session is revoked');
  assert.equal(await store.checkUserPassword('victim@example.com', 'squatter password'), undefined);

  // The same holds when a link scanner (or the victim) confirmed the squatter's address first.
  const early = await store.createPasswordUser('scanned@example.com', 'squatter password', null);
  store.markEmailVerified(early.id);
  const earlySession = store.createUserSession(early.id);
  const linked = store.signInWithIdentity({ provider: 'google', label: 'Google', subject: 'g-scanned', email: 'scanned@example.com', emailVerified: true });
  assert.equal(linked.passwordRemoved, true);
  assert.equal(store.userFromSession(earlySession.token), undefined);
  assert.equal(await store.checkUserPassword('scanned@example.com', 'squatter password'), undefined);
  // Joining an account without a password (another provider) keeps its sessions.
  const appleOnly = store.signInWithIdentity({ provider: 'apple', label: 'Apple', subject: 'a-only', email: 'both@example.com', emailVerified: true }).user;
  const appleSession = store.createUserSession(appleOnly.id);
  assert.equal(store.signInWithIdentity({ provider: 'google', label: 'Google', subject: 'g-both', email: 'both@example.com', emailVerified: true }).passwordRemoved, false);
  assert.equal(store.userFromSession(appleSession.token)?.id, appleOnly.id);
});

test('OAuth state is bound to its provider and used once', () => {
  const check = store.createOAuthState('google', '/account');
  assert.equal(store.consumeOAuthState(check.state, 'apple'), undefined);
  const again = store.createOAuthState('google', '/s/0123456789ab/title');
  const result = store.consumeOAuthState(again.state, 'google');
  assert.deepEqual(result, { verifier: again.verifier, nonce: again.nonce, returnPath: '/s/0123456789ab/title' });
  assert.equal(store.consumeOAuthState(again.state, 'google'), undefined);
});

test('rate limits count every key and reset after their window', () => {
  for (let attempt = 0; attempt < 3; attempt++) assert.equal(allowAttempt([['test:a', 3], ['test:global', 10]]), true);
  assert.equal(allowAttempt([['test:a', 3], ['test:global', 10]]), false);
  assert.equal(allowAttempt([['test:b', 3], ['test:global', 10]]), true);
  assert.equal(allowAttempt([['test:short', 1]], -1), true);
  assert.equal(allowAttempt([['test:short', 1]], -1), true, 'an elapsed window starts over');
});

test('spaces, uploads and the processing queue', async () => {
  const user = await store.createPasswordUser('spaces@example.com', 'password one', null);
  const space = store.createCustomerSpace(user.id, 'Studio', 'draft');
  assert.match(space.id, /^[a-f0-9]{12}$/);
  assert.equal(store.billableSpaceCount(user.id), 1);
  store.createCustomerSpace(user.id, 'Waiting', 'unpaid');
  assert.equal(store.billableSpaceCount(user.id), 1, 'unpaid spaces are not billed yet');
  assert.equal(store.payableSpaceCount(user.id), 2);

  assert.throws(() => store.submitCustomerSpace(space.id, null), /Upload at least one file/);
  const limit = 10e9;
  const upload = store.createUploadRecord(space.id, 'scan.e57', 5e9, 'application/octet-stream', id => `uploads/${space.id}/${id}/scan.e57`, limit);
  assert.throws(() => store.createUploadRecord(space.id, 'more.zip', 6e9, 'application/zip', id => id, limit), /limited to 10 GB/);
  assert.throws(() => store.submitCustomerSpace(space.id, null), /Upload at least one file/, 'incomplete uploads do not count');
  const second = store.createUploadRecord(space.id, 'photo.jpg', 1000, 'image/jpeg', id => id, limit);
  store.setUploadStatus(upload.id, 'complete');
  assert.throws(() => store.submitCustomerSpace(space.id, null), /Wait for every upload/);
  store.setUploadStatus(second.id, 'deleted');

  const job = store.submitCustomerSpace(space.id, 'A two-floor studio.');
  assert.equal(store.readCustomerSpace(space.id).status, 'queued');
  assert.match(job.sceneId, /^[a-f0-9]{12}$/);
  assert.throws(() => store.submitCustomerSpace(space.id, null), /cannot be submitted/);
  assert.deepEqual(store.listJobs(['queued']).map(item => item.id), [job.id]);
  assert.ok(store.claimJob(job.id, 'worker-a'));
  assert.equal(store.claimJob(job.id, 'worker-b'), undefined, 'a job is claimed once');
  assert.equal(store.readCustomerSpace(space.id).status, 'processing');
  assert.equal(store.releaseJob(job.id), true);
  assert.equal(store.readCustomerSpace(space.id).status, 'queued');
  store.claimJob(job.id, 'worker-a');
  const listing = { sceneId: job.sceneId, slug: `customer-${space.id}` };
  const done = store.finishJob(job.id, { ok: true, message: 'Built 12 scan positions.', listing });
  assert.equal(done.space.status, 'ready');
  assert.equal(done.space.sceneId, job.sceneId);
  assert.equal(store.spaceForScene(job.sceneId).id, space.id);
  assert.deepEqual(store.readCustomerListings(), [listing], 'the listing is served from the database');
  assert.throws(() => store.finishJob(job.id, { ok: true, message: null, listing }), /not running/);

  // Reprocessing keeps the space's scene ID so links survive.
  const redo = store.submitCustomerSpace(space.id, null);
  assert.equal(redo.sceneId, job.sceneId);
  store.claimJob(redo.id, 'worker-a');
  const held = store.holdJob(redo.id, 'Unfamiliar format.');
  assert.ok(held?.transitioned, 'holding a job reports the space moved out of processing');
  assert.equal(store.readJob(redo.id).status, 'held');
  assert.equal(store.readCustomerSpace(space.id).status, 'failed', 'a held job shows the customer a reason, not endless processing');
  assert.equal(store.readCustomerSpace(space.id).message, store.heldSpaceMessage);
  store.expireJobLeases(-1);
  assert.equal(store.readJob(redo.id).status, 'held', 'held jobs wait for an operator, not the lease');
  // An operator can put a held job back in the queue, clearing the customer-facing error.
  assert.equal(store.releaseJob(redo.id), true);
  assert.equal(store.readCustomerSpace(space.id).status, 'queued');
  store.claimJob(redo.id, 'worker-a');
  const failed = store.finishJob(redo.id, { ok: false, message: 'The ZIP contained no E57 file.' });
  assert.equal(failed.space.status, 'failed');
  assert.equal(failed.space.sceneId, job.sceneId, 'a failed reprocess keeps the published scene');

  // Deleting while a job runs cancels its result.
  const other = store.createCustomerSpace(user.id, 'Gallery', 'draft');
  const file = store.createUploadRecord(other.id, 'gallery.zip', 10, 'application/zip', id => id, limit);
  store.setUploadStatus(file.id, 'complete');
  const running = store.submitCustomerSpace(other.id, null);
  store.claimJob(running.id, 'worker-a');
  store.deleteCustomerSpace(other.id);
  assert.equal(store.readJob(running.id).status, 'canceled', 'deleting cancels the running job');
  assert.throws(() => store.finishJob(running.id, { ok: true, message: null, listing: {} }), /not running/);
  assert.equal(store.readCustomerSpace(other.id).sceneId, null);
  assert.equal(store.billableSpaceCount(user.id), 1);
  assert.equal(store.readCustomerListings().length, 1, 'deleted spaces are no longer listed');

  // A worker that disappears returns its job to the queue until the attempts run out.
  const stalled = store.createCustomerSpace(user.id, 'Stalled', 'draft');
  const part = store.createUploadRecord(stalled.id, 'part.zip', 10, 'application/zip', id => id, limit);
  store.setUploadStatus(part.id, 'complete');
  const lease = store.submitCustomerSpace(stalled.id, null);
  for (let attempt = 1; attempt <= store.maxJobAttempts; attempt++) {
    assert.ok(store.claimJob(lease.id, 'worker-a'));
    store.expireJobLeases(-1);
    assert.equal(store.readJob(lease.id).status, attempt < store.maxJobAttempts ? 'queued' : 'held');
  }
  assert.equal(store.readCustomerSpace(stalled.id).status, 'failed', 'a job that gives up stops the space processing');
});

test('ID tokens: signature, issuer, audience, lifetime, nonce and key rotation', async () => {
  const { verifyIdToken, appleClientSecret, appleName } = await import('../lib/server/oauth.ts');
  const signer = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rotated = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let keys = [{ ...signer.publicKey.export({ format: 'jwk' }), kid: 'one', alg: 'RS256', use: 'sig' }];
  let fetches = 0;
  const { server, base } = await listen((request, response) => { fetches++; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ keys })); });
  after(() => server.close());
  const provider = { id: 'google', label: 'Google', jwks: `${base}/jwks`, issuers: ['https://accounts.google.com'], clientId: 'client-1', requireNonce: true };
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: 'https://accounts.google.com', aud: 'client-1', sub: 'user-1', email: 'a@example.com', email_verified: true, nonce: 'n-1', iat: now, exp: now + 600 };
  function jwt(payload, key = signer.privateKey, kid = 'one') {
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const body = `${encode({ alg: 'RS256', kid })}.${encode(payload)}`;
    return `${body}.${createSign('RSA-SHA256').update(body).sign(key, 'base64url')}`;
  }
  assert.equal((await verifyIdToken(provider, jwt(claims), 'n-1')).sub, 'user-1');
  await assert.rejects(() => verifyIdToken(provider, jwt({ ...claims, aud: 'someone-else' }), 'n-1'), /another application/);
  await assert.rejects(() => verifyIdToken(provider, jwt({ ...claims, iss: 'https://evil.example' }), 'n-1'), /issuer/);
  await assert.rejects(() => verifyIdToken(provider, jwt({ ...claims, exp: now - 3600 }), 'n-1'), /Expired/);
  await assert.rejects(() => verifyIdToken(provider, jwt(claims), 'n-2'), /nonce/);
  await assert.rejects(() => verifyIdToken(provider, jwt({ ...claims, nonce: undefined }), 'n-1'), /nonce/);
  await assert.rejects(() => verifyIdToken(provider, jwt(claims, rotated.privateKey), 'n-1'), /signature/);
  const [header, payload] = jwt(claims).split('.');
  await assert.rejects(() => verifyIdToken(provider, `${header}.${payload}.`, 'n-1'), /signature/);
  const none = `${Buffer.from(JSON.stringify({ alg: 'none', kid: 'one' })).toString('base64url')}.${payload}.`;
  await assert.rejects(() => verifyIdToken(provider, none, 'n-1'), /Unsupported/);
  // LinkedIn does not require a nonce, but a present nonce must match.
  const linkedin = { ...provider, requireNonce: false };
  assert.ok(await verifyIdToken(linkedin, jwt({ ...claims, nonce: undefined }), 'n-1'));
  await assert.rejects(() => verifyIdToken(linkedin, jwt(claims), 'n-2'), /nonce/);
  // A new signing key is fetched when an unknown key ID appears.
  keys = [...keys, { ...rotated.publicKey.export({ format: 'jwk' }), kid: 'two' }];
  const before = fetches;
  assert.ok(await verifyIdToken(provider, jwt(claims, rotated.privateKey, 'two'), 'n-1'));
  assert.equal(fetches, before + 1);

  const apple = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const secret = appleClientSecret('com.example.web', 'TEAM123456', 'KEY1234567', apple.privateKey.export({ format: 'pem', type: 'pkcs8' }), 1000);
  const [h, p, s] = secret.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'KEY1234567', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url')), { iss: 'TEAM123456', iat: 1000, exp: 1300, aud: 'https://appleid.apple.com', sub: 'com.example.web' });
  assert.equal(Buffer.from(s, 'base64url').length, 64, 'ES256 signatures are raw r||s');
  assert.ok(createVerify('sha256').update(`${h}.${p}`).verify({ key: apple.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  assert.equal(appleName(JSON.stringify({ name: { firstName: 'Ada', lastName: 'Lovelace' } })), 'Ada Lovelace');
  assert.equal(appleName('not json'), null);
});

const fake = fakeStripe();
const stripeServer = await listen(fake.handler);
after(() => stripeServer.server.close());

test('billing follows the number of hosted spaces', async () => {
  Object.assign(process.env, { SPHR_STRIPE_SECRET_KEY: 'sk_test_fake', SPHR_STRIPE_PRICE_ID: 'price_space', SPHR_STRIPE_WEBHOOK_SECRET: 'whsec_test',
    SPHR_STRIPE_TEST_API: stripeServer.base, SPHR_STRIPE_PLAN_PRICES: 'price_pro, price_starter,price_missing,price_enterprise' });
  const billing = await import('../lib/server/billing.ts');
  // Pay as you go first, then the plans from the smallest; a price Stripe cannot find is left out.
  assert.deepEqual((await billing.readPlans()).map(plan => [plan.id, plan.name, plan.amount, plan.spaces]), [
    ['price_space', 'Pay as you go', 100, null], ['price_starter', 'Starter', 800, 6], ['price_pro', 'Pro', 5000, 30], ['price_enterprise', 'Enterprise', 24900, 200]]);

  const user = await store.createPasswordUser('billing@example.com', 'password one', 'Bill Ing');
  store.markEmailVerified(user.id);
  store.createCustomerSpace(user.id, 'First', 'unpaid');
  store.createCustomerSpace(user.id, 'Second', 'unpaid');
  const { url, plan } = await billing.startCheckout(store.readUser(user.id), 'https://app.example');
  const [session] = fake.state.sessions.values();
  assert.equal(url, session.url);
  assert.equal(plan, 'price_space', 'pay as you go unless another plan is chosen');
  assert.equal(session.quantity, 2, 'Checkout covers every waiting space');
  assert.equal(session.success_url, 'https://app.example/account?checkout={CHECKOUT_SESSION_ID}');
  const [again, twice] = await Promise.all([1, 2].map(() => billing.startCheckout(store.readUser(user.id), 'https://app.example')));
  assert.deepEqual([again.url, twice.url], [url, url], 'an open session is reused, also by concurrent requests');
  assert.equal(fake.state.sessions.size, 1);
  store.createCustomerSpace(user.id, 'Third', 'unpaid');
  const { url: replaced } = await billing.startCheckout(store.readUser(user.id), 'https://app.example');
  assert.notEqual(replaced, url, 'a different quantity replaces the open session');
  assert.equal(session.status, 'expired');

  const current = [...fake.state.sessions.values()].at(-1);
  await billing.applyCheckoutSession(current.id, 'someone-else');
  assert.equal(store.readSubscription(user.id), undefined, 'an unpaid session changes nothing');
  const subscription = fake.state.pay(current.id);
  await billing.applyCheckoutSession(current.id, 'someone-else');
  assert.equal(store.readSubscription(user.id), undefined, 'another customer cannot apply the session');
  await billing.applyCheckoutSession(current.id, user.id);
  assert.equal(store.readSubscription(user.id).status, 'active');
  assert.deepEqual(store.readSubscription(user.id).plan, { price: 'price_space', amount: 100, currency: 'usd', interval: 'month', intervalCount: 1, spaces: null });
  assert.equal(store.billableSpaceCount(user.id), 3, 'paid spaces open for uploads');
  assert.equal(fake.state.updates.length, 0, 'quantity already matches');
  assert.equal(store.readUser(user.id).checkoutSession, null);

  store.createCustomerSpace(user.id, 'Fourth', 'draft');
  await billing.syncQuantity(user.id);
  assert.deepEqual(fake.state.updates.at(-1), { quantity: 4, proration: 'create_prorations' });
  const [space] = store.listCustomerSpaces(user.id);
  store.deleteCustomerSpace(space.id);
  await Promise.all([billing.syncQuantity(user.id), billing.syncQuantity(user.id)]);
  assert.equal(subscription.items.data[0].quantity, 3);
  assert.equal(store.readSubscription(user.id).quantity, 3);

  // Out-of-order events: an older, ended subscription never replaces the live one.
  const stale = { ...structuredClone(subscription), id: 'sub_old', status: 'canceled' };
  fake.state.subscriptions.set(stale.id, stale);
  await billing.syncSubscription(stale.id);
  assert.equal(store.readSubscription(user.id).id, subscription.id);
  subscription.status = 'past_due';
  await billing.syncSubscription(subscription.id);
  assert.equal(store.hostingActive(user.id), true, 'past-due accounts stay online while Stripe retries');
  subscription.status = 'canceled';
  await billing.syncSubscription(subscription.id);
  assert.equal(store.hostingActive(user.id), false, 'ended subscriptions pause hosting');

  // A paid session whose webhook has not arrived is applied, not paid again.
  const other = await store.createPasswordUser('second@example.com', 'password one', null);
  store.createCustomerSpace(other.id, 'Only', 'unpaid');
  const first = await billing.startCheckout(store.readUser(other.id), 'https://app.example');
  const paidSession = [...fake.state.sessions.values()].find(item => item.url === first.url);
  const otherSubscription = fake.state.pay(paidSession.id);
  const sessionsBefore = fake.state.sessions.size;
  assert.deepEqual(await billing.startCheckout(store.readUser(other.id), 'https://app.example'), { paid: true });
  assert.equal(fake.state.sessions.size, sessionsBefore, 'no second Checkout');
  assert.equal(store.readSubscription(other.id).status, 'active');
  // An unpaid subscription is repaired in the portal rather than replaced.
  otherSubscription.status = 'unpaid';
  await billing.syncSubscription(otherSubscription.id);
  assert.deepEqual(await billing.startCheckout(store.readUser(other.id), 'https://app.example'), { portal: 'https://billing.example/portal' });
  assert.equal(fake.state.sessions.size, sessionsBefore);
  // Changing the configured price does not detach existing subscriptions.
  process.env.SPHR_STRIPE_PRICE_ID = 'price_new';
  otherSubscription.status = 'canceled';
  await billing.syncSubscription(otherSubscription.id);
  assert.equal(store.readSubscription(other.id).status, 'canceled');
  process.env.SPHR_STRIPE_PRICE_ID = 'price_space';

  // Webhook signatures.
  const stripe = billing.stripe();
  const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'customer.subscription.updated', data: { object: { id: subscription.id } } });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test' });
  assert.equal(stripe.webhooks.constructEvent(payload, header, 'whsec_test').id, 'evt_1');
  assert.throws(() => stripe.webhooks.constructEvent(payload, header, 'whsec_other'));
  assert.equal(await billing.portalUrl(store.readUser(user.id), 'https://app.example'), 'https://billing.example/portal');
});

test('plans cover a set number of spaces for one price', async () => {
  const billing = await import('../lib/server/billing.ts');
  const user = await store.createPasswordUser('plans@example.com', 'password one', null);
  store.markEmailVerified(user.id);
  store.createCustomerSpace(user.id, 'Porch', 'unpaid');
  const origin = 'https://app.example';

  // Choosing a plan at Checkout: one unit of the plan's price, whatever the number of spaces.
  const payg = await billing.startCheckout(store.readUser(user.id), origin);
  const starter = await billing.startCheckout(store.readUser(user.id), origin, 'price_starter');
  assert.equal(starter.plan, 'price_starter');
  assert.notEqual(starter.url, payg.url);
  const session = [...fake.state.sessions.values()].at(-1);
  assert.deepEqual([session.price, session.quantity], ['price_starter', 1]);
  assert.equal([...fake.state.sessions.values()].find(item => item.url === payg.url).status, 'expired', 'the earlier choice is withdrawn');
  await assert.rejects(() => billing.startCheckout(store.readUser(user.id), origin, 'price_missing'), /not offered/);
  // Another space keeps the chosen plan while it covers every space.
  store.createCustomerSpace(user.id, 'Kitchen', 'unpaid');
  const kept = await billing.startCheckout(store.readUser(user.id), origin);
  assert.equal(kept.plan, 'price_starter');
  assert.equal([...fake.state.sessions.values()].at(-1).quantity, 1);
  for (const title of ['Hall', 'Attic', 'Cellar', 'Garden', 'Garage']) store.createCustomerSpace(user.id, title, 'unpaid');
  await assert.rejects(() => billing.startCheckout(store.readUser(user.id), origin, 'price_starter'), /Starter covers up to 6 spaces/);
  const grown = await billing.startCheckout(store.readUser(user.id), origin);
  assert.equal(grown.plan, 'price_space', 'a plan too small for every space falls back to pay as you go');
  assert.equal([...fake.state.sessions.values()].at(-1).quantity, 7);
  store.deleteCustomerSpace(store.listCustomerSpaces(user.id).find(space => space.title === 'Garage').id);

  // Paying for Starter with six spaces.
  const paid = await billing.startCheckout(store.readUser(user.id), origin, 'price_starter');
  const subscription = fake.state.pay([...fake.state.sessions.values()].find(item => item.url === paid.url).id);
  await billing.syncSubscription(subscription.id);
  assert.equal(store.readSubscription(user.id).plan.spaces, 6);
  assert.equal(store.planSpaceLimit(user.id), 6);
  assert.equal(store.billableSpaceCount(user.id), 6);
  assert.equal(subscription.items.data[0].quantity, 1, 'a plan is one unit however many spaces it holds');
  assert.throws(() => store.createCustomerSpace(user.id, 'Seventh', 'draft', 6), error => error instanceof store.PlanLimitError);
  const [hall] = store.listCustomerSpaces(user.id);
  store.deleteCustomerSpace(hall.id);
  await billing.syncQuantity(user.id);
  assert.equal(subscription.items.data[0].quantity, 1, 'deleting a space leaves a plan as it is');

  // Changing plans keeps the subscription item and prorates onto the next invoice.
  const itemId = subscription.items.data[0].id;
  await assert.rejects(() => billing.changePlan(store.readUser(user.id), 'price_missing'), /not offered/);
  await billing.changePlan(store.readUser(user.id), 'price_pro');
  assert.deepEqual(fake.state.planChanges.at(-1), { price: 'price_pro', quantity: 1, proration: 'create_prorations' });
  assert.equal(subscription.items.data[0].id, itemId);
  assert.equal(store.readSubscription(user.id).plan.spaces, 30);
  const changes = fake.state.planChanges.length;
  await billing.changePlan(store.readUser(user.id), 'price_pro');
  assert.equal(fake.state.planChanges.length, changes, 'choosing the current plan changes nothing');
  await billing.changePlan(store.readUser(user.id), 'price_space');
  assert.deepEqual(fake.state.planChanges.at(-1), { price: 'price_space', quantity: 5, proration: 'create_prorations' }, 'pay as you go counts the spaces');
  assert.equal(store.readSubscription(user.id).plan.spaces, null);
  assert.equal(store.planSpaceLimit(user.id), null);
  for (const title of ['One', 'Two']) store.createCustomerSpace(user.id, title, 'draft');
  await billing.syncQuantity(user.id);
  assert.equal(subscription.items.data[0].quantity, 7);
  await assert.rejects(() => billing.changePlan(store.readUser(user.id), 'price_starter'), /Starter covers up to 6 spaces and you have 7/);
  subscription.status = 'canceled';
  await billing.syncSubscription(subscription.id);
  await assert.rejects(() => billing.changePlan(store.readUser(user.id), 'price_pro'), /Start hosting/);
});
