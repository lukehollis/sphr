// Local stand-ins for Stripe, OpenID Connect providers and an SMTP server, for account tests.
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { createHash, createSign, createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';

export function listen(handler) {
  return new Promise(resolve => {
    const server = createServer(handler).listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

// Prices the stand-in knows: pay as you go per space, and plans covering a set number of spaces.
export const fakePrices = {
  price_space: { unit_amount: 100, product: { id: 'prod_space', name: 'Pay as you go' }, metadata: {} },
  price_starter: { unit_amount: 800, product: { id: 'prod_starter', name: 'Starter' }, metadata: { sphr_plan: 'starter', sphr_spaces: '6' } },
  price_pro: { unit_amount: 5000, product: { id: 'prod_pro', name: 'Pro' }, metadata: { sphr_plan: 'pro', sphr_spaces: '30' } },
  price_enterprise: { unit_amount: 24900, product: { id: 'prod_enterprise', name: 'Enterprise' }, metadata: { sphr_plan: 'enterprise', sphr_spaces: '200' } }
};

// A small stand-in for the Stripe API, keeping just enough state for billing flows.
// Checkout links point at `checkoutBase`, so a local page can stand in for Checkout.
export function fakeStripe({ checkoutBase = 'https://checkout.example' } = {}) {
  const state = { customers: new Map(), sessions: new Map(), subscriptions: new Map(), setupIntents: new Map(), updates: [], planChanges: [], counter: 0 };
  const id = prefix => `${prefix}_test${++state.counter}`;
  const price = (priceId, expand) => {
    const known = fakePrices[priceId] ?? { unit_amount: 100, product: { id: 'prod_other', name: 'Other' }, metadata: {} };
    return { id: priceId, object: 'price', active: true, currency: 'usd', unit_amount: known.unit_amount, metadata: known.metadata,
      nickname: null, recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
      product: expand ? { object: 'product', ...known.product } : known.product.id };
  };
  const handler = async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const form = new URLSearchParams(body);
    const url = new URL(request.url, 'http://stripe');
    const send = (value, status = 200) => { response.statusCode = status; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
    const parts = url.pathname.split('/').filter(Boolean);
    if (request.method === 'GET' && parts[1] === 'prices') return send(price(parts[2], [...url.searchParams].some(([key, value]) => key.startsWith('expand') && value === 'product')));
    if (request.method === 'POST' && parts[1] === 'customers' && parts.length === 2) {
      const customer = { id: id('cus'), object: 'customer', email: form.get('email'), metadata: { sphr_user: form.get('metadata[sphr_user]') } };
      state.customers.set(customer.id, customer);
      return send(customer);
    }
    if (request.method === 'POST' && parts[1] === 'customers' && parts[2]) {
      const customer = state.customers.get(parts[2]);
      if (!customer) return send({ error: { message: 'No such customer', type: 'invalid_request_error' } }, 404);
      if (form.has('invoice_settings[default_payment_method]')) customer.invoice_settings = { default_payment_method: form.get('invoice_settings[default_payment_method]') };
      return send(customer);
    }
    if (request.method === 'GET' && parts[1] === 'setup_intents') {
      const intent = state.setupIntents.get(parts[2]);
      return intent ? send(intent) : send({ error: { message: 'No such setup intent', type: 'invalid_request_error' } }, 404);
    }
    if (parts[1] === 'checkout' && parts[2] === 'sessions') {
      if (request.method === 'POST' && parts.length === 3) {
        const session = { id: id('cs'), object: 'checkout.session', mode: form.get('mode'), status: 'open', customer: form.get('customer'),
          client_reference_id: form.get('client_reference_id'), url: `${checkoutBase}/${state.counter}`, subscription: null,
          quantity: Number(form.get('line_items[0][quantity]')), price: form.get('line_items[0][price]'), success_url: form.get('success_url'),
          cancel_url: form.get('cancel_url'), currency: form.get('currency'), setup_intent: null };
        state.sessions.set(session.id, session);
        return send(session);
      }
      const session = state.sessions.get(parts[3]);
      if (!session) return send({ error: { message: 'No such session', type: 'invalid_request_error' } }, 404);
      if (parts[4] === 'expire') { session.status = 'expired'; return send(session); }
      return send({ ...session, line_items: { object: 'list', data: [{ quantity: session.quantity, price: price(session.price) }] } });
    }
    if (request.method === 'GET' && parts[1] === 'subscriptions' && parts.length === 2) {
      const data = [...state.subscriptions.values()].filter(item => item.customer === url.searchParams.get('customer'));
      return send({ object: 'list', data, has_more: false, url: '/v1/subscriptions' });
    }
    if (parts[1] === 'subscriptions') {
      const subscription = state.subscriptions.get(parts[2]);
      if (!subscription) return send({ error: { message: 'No such subscription', type: 'invalid_request_error' } }, 404);
      if (request.method === 'POST') {
        // Changing plans: the item keeps its ID and takes the new price and quantity.
        const item = subscription.items.data.find(entry => entry.id === form.get('items[0][id]'));
        if (!item) return send({ error: { message: 'No such item', type: 'invalid_request_error' } }, 400);
        if (form.has('items[0][price]')) item.price = price(form.get('items[0][price]'));
        if (form.has('items[0][quantity]')) item.quantity = Number(form.get('items[0][quantity]'));
        state.planChanges.push({ price: item.price.id, quantity: item.quantity, proration: form.get('proration_behavior') });
      }
      if (request.method === 'GET' && state.nextRead) {
        // A held read answers with what Stripe had when the request arrived, once the test releases it.
        const { arrived, gate } = state.nextRead;
        state.nextRead = undefined;
        const snapshot = structuredClone(subscription);
        arrived();
        await gate;
        return send(snapshot);
      }
      return send(subscription);
    }
    if (request.method === 'POST' && parts[1] === 'subscription_items') {
      for (const subscription of state.subscriptions.values()) {
        const item = subscription.items.data.find(entry => entry.id === parts[2]);
        if (item) {
          item.quantity = Number(form.get('quantity'));
          state.updates.push({ quantity: item.quantity, proration: form.get('proration_behavior') });
          return send(item);
        }
      }
      return send({ error: { message: 'No such item', type: 'invalid_request_error' } }, 404);
    }
    if (request.method === 'POST' && parts[1] === 'billing_portal') return send({ id: id('bps'), url: 'https://billing.example/portal' });
    send({ error: { message: `Unhandled ${request.method} ${url.pathname}`, type: 'invalid_request_error' } }, 400);
  };
  // Simulates a customer paying: Stripe creates the subscription for the session's quantity.
  state.pay = sessionId => {
    const session = state.sessions.get(sessionId);
    const subscription = { id: id('sub'), object: 'subscription', status: 'active', customer: session.customer, cancel_at_period_end: false,
      metadata: { sphr_user: session.client_reference_id },
      items: { object: 'list', data: [{ id: id('si'), object: 'subscription_item', quantity: session.quantity, current_period_end: 1900000000, price: price(session.price) }] } };
    state.subscriptions.set(subscription.id, subscription);
    Object.assign(session, { status: 'complete', subscription: subscription.id });
    return subscription;
  };
  // Holds the next subscription read, to overlap two syncs: `reached` resolves when it arrives, `release` sends its reply.
  state.holdNextRead = () => {
    let arrived, release;
    const reached = new Promise(resolve => { arrived = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    state.nextRead = { arrived, gate };
    return { reached, release };
  };
  // Simulates a customer saving a card in a setup-mode Checkout.
  state.saveCard = sessionId => {
    const session = state.sessions.get(sessionId);
    const intent = { id: id('seti'), object: 'setup_intent', status: 'succeeded', customer: session.customer, payment_method: id('pm') };
    state.setupIntents.set(intent.id, intent);
    Object.assign(session, { status: 'complete', setup_intent: intent.id });
    return intent;
  };
  return { state, handler };
}


/**
 * One OpenID Connect provider per path prefix (/google, /apple, /linkedin). The test plays
 * the browser: it reads the authorization redirect, then calls the app's callback with a code.
 */
export function fakeIdentityProvider({ clients, applePublicKey }) {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...key.publicKey.export({ format: 'jwk' }), kid: 'fake-1', alg: 'RS256', use: 'sig' };
  const codes = new Map(), tokens = new Map();
  const state = { base: '', exchanges: [] };
  const sign = claims => {
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const body = `${encode({ alg: 'RS256', kid: 'fake-1', typ: 'JWT' })}.${encode(claims)}`;
    return `${body}.${createSign('RSA-SHA256').update(body).sign(key.privateKey, 'base64url')}`;
  };
  function validSecret(provider, form) {
    if (provider !== 'apple') return form.get('client_secret') === clients[provider].secret;
    const [header, payload, signature] = (form.get('client_secret') ?? '').split('.');
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString() || '{}');
    return createVerify('sha256').update(`${header}.${payload}`).verify({ key: applePublicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature ?? '', 'base64url'))
      && claims.sub === clients.apple.id && claims.aud === 'https://appleid.apple.com' && claims.exp > Date.now() / 1000;
  }
  const handler = async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const [provider, action] = new URL(request.url, 'http://idp').pathname.split('/').filter(Boolean);
    const send = (value, status = 200) => { response.statusCode = status; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
    if (action === 'jwks') return send({ keys: [jwk] });
    if (action === 'token' && request.method === 'POST') {
      const form = new URLSearchParams(body);
      const entry = codes.get(form.get('code'));
      codes.delete(form.get('code'));
      state.exchanges.push({ provider, form: Object.fromEntries(form) });
      if (!entry || entry.provider !== provider || form.get('client_id') !== clients[provider].id || !validSecret(provider, form)
        || form.get('redirect_uri') !== entry.redirectUri || form.get('grant_type') !== 'authorization_code') return send({ error: 'invalid_grant' }, 400);
      if (entry.challenge && createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== entry.challenge) return send({ error: 'invalid_grant' }, 400);
      const now = Math.floor(Date.now() / 1000);
      const accessToken = randomBytes(16).toString('hex');
      tokens.set(accessToken, entry.userinfo);
      return send({ token_type: 'Bearer', access_token: accessToken, id_token: sign({ iss: `${state.base}/${provider}`, aud: clients[provider].id, iat: now, exp: now + 600, ...entry.claims }) });
    }
    if (action === 'userinfo') {
      const info = tokens.get(request.headers.authorization?.replace('Bearer ', ''));
      return info ? send(info) : send({ error: 'invalid_token' }, 401);
    }
    send({ error: 'not_found' }, 404);
  };
  /** Accepts the authorization request the app redirected to and issues a code for these claims. */
  function authorize(location, claims, { includeNonce = true, userinfo } = {}) {
    const url = new URL(location);
    const provider = url.pathname.split('/').filter(Boolean)[0];
    const params = Object.fromEntries(url.searchParams);
    const code = randomBytes(12).toString('hex');
    codes.set(code, { provider, redirectUri: params.redirect_uri, challenge: params.code_challenge, userinfo,
      claims: { ...claims, ...(includeNonce && params.nonce ? { nonce: params.nonce } : {}) } });
    return { code, params };
  }
  return { handler, authorize, state };
}

/** Accepts every message and keeps its decoded text. */
export function smtpSink() {
  const messages = [];
  const server = createTcpServer(socket => {
    let buffer = '', data = false, message = '';
    socket.setEncoding('utf8');
    socket.write('220 localhost ESMTP\r\n');
    socket.on('data', chunk => {
      buffer += chunk;
      for (let index; (index = buffer.indexOf('\r\n')) >= 0;) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (data) {
          if (line === '.') { data = false; messages.push(decodeMessage(message)); message = ''; socket.write('250 Queued\r\n'); }
          else message += (line.startsWith('..') ? line.slice(1) : line) + '\n';
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250-localhost\r\n250 8BITMIME\r\n');
        else if (verb === 'DATA') { data = true; socket.write('354 Go ahead\r\n'); }
        else if (verb === 'QUIT') socket.end('221 Bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  async function waitFor(match, timeout = 10000) {
    const started = Date.now();
    for (;;) {
      const found = messages.find(match);
      if (found) return found;
      if (Date.now() - started > timeout) throw new Error('Expected email did not arrive.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, messages, waitFor })));
}

function decodeMessage(raw) {
  const [headers, ...rest] = raw.split('\n\n');
  let body = rest.join('\n\n');
  // Plain text with an HTML alternative: decode each part.
  const boundary = headers.replace(/\n\s+/g, ' ').match(/Content-Type: multipart\/[\w-]+;.*?boundary="?([^";\s]+)"?/i)?.[1];
  if (boundary) {
    const parts = body.split(`--${boundary}`).slice(1).filter(part => !part.startsWith('--'));
    return `${headers}\n\n${parts.map(part => decodeMessage(part.replace(/^\n/, ''))).join('\n\n')}`;
  }
  if (/Content-Transfer-Encoding: base64/i.test(headers)) body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (/Content-Transfer-Encoding: quoted-printable/i.test(headers)) {
    body = Buffer.from(body.replace(/=\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1').toString('utf8');
  }
  return `${headers}\n\n${body}`;
}
