#!/usr/bin/env node
// Creates or updates the Stripe objects per-space hosting needs, in the mode of the key given
// (test or live): the "Space hosting" product, a monthly per-space price, the webhook endpoint
// and a billing portal configuration without quantity changes. Safe to run again.
//   SPHR_STRIPE_SECRET_KEY=sk_… node scripts/deploy/stripe-setup.mjs --origin https://app.example.com [--amount 200] [--currency usd]
// Prints KEY=VALUE lines for the application environment. SPHR_STRIPE_WEBHOOK_SECRET, when set,
// keeps the existing endpoint; otherwise the endpoint is recreated to obtain a new secret.
import Stripe from 'stripe';

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map(part => part.trim().split(/\s+/)));
const key = process.env.SPHR_STRIPE_SECRET_KEY?.trim();
const origin = (args.origin ?? '').replace(/\/$/, '');
const amount = Number(args.amount ?? 200), currency = (args.currency ?? 'usd').toLowerCase(), interval = 'month';
if (!key || !/^(sk|rk)_(test|live)_/.test(key)) { console.error('Set SPHR_STRIPE_SECRET_KEY to a Stripe secret key.'); process.exit(1); }
if (!/^https:\/\/[^/]+$/.test(origin)) { console.error('Pass --origin with the application\'s HTTPS origin.'); process.exit(1); }
if (!Number.isInteger(amount) || amount < 50) { console.error('--amount is in the smallest currency unit, at least 50.'); process.exit(1); }
const stripe = new Stripe(key);
const mode = key.includes('_live_') ? 'live' : 'test';

let product = (await stripe.products.list({ limit: 100, active: true })).data.find(item => item.metadata?.sphr === 'space-hosting');
product ??= await stripe.products.create({ name: 'Space hosting', description: 'Hosting for one space.', metadata: { sphr: 'space-hosting' } });

const lookup = `sphr-space-${interval}-${currency}-${amount}`;
let price = (await stripe.prices.list({ lookup_keys: [lookup], active: true, limit: 1 })).data[0];
price ??= await stripe.prices.create({ product: product.id, currency, unit_amount: amount, lookup_key: lookup,
  recurring: { interval, usage_type: 'licensed' }, nickname: `Per space, ${amount / 100} ${currency.toUpperCase()} per ${interval}` });

const url = `${origin}/api/stripe/webhook`;
const events = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'customer.subscription.created',
  'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.paused', 'customer.subscription.resumed'];
const endpoints = (await stripe.webhookEndpoints.list({ limit: 100 })).data.filter(item => item.url === url);
let secret = process.env.SPHR_STRIPE_WEBHOOK_SECRET?.trim();
if (endpoints.length && secret) {
  await stripe.webhookEndpoints.update(endpoints[0].id, { enabled_events: events, disabled: false });
} else {
  for (const endpoint of endpoints) await stripe.webhookEndpoints.del(endpoint.id);
  const endpoint = await stripe.webhookEndpoints.create({ url, enabled_events: events, description: 'SPHR space hosting' });
  secret = endpoint.secret;
}

const portal = {
  business_profile: { headline: 'Manage your space hosting', privacy_policy_url: `${origin}/privacy`, terms_of_service_url: `${origin}/terms` },
  default_return_url: `${origin}/account`,
  features: {
    customer_update: { enabled: true, allowed_updates: ['email', 'address', 'tax_id'] },
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: { enabled: true, mode: 'at_period_end', proration_behavior: 'none' },
    // The quantity always follows the number of spaces; customers change it by adding or deleting spaces.
    subscription_update: { enabled: false }
  }
};
const existing = (await stripe.billingPortal.configurations.list({ limit: 100, active: true })).data.find(item => item.metadata?.sphr === 'space-hosting');
const configuration = existing ? await stripe.billingPortal.configurations.update(existing.id, portal)
  : await stripe.billingPortal.configurations.create({ ...portal, metadata: { sphr: 'space-hosting' } });

console.error(`Stripe ${mode} mode: product ${product.id}, price ${price.id} (${amount / 100} ${currency.toUpperCase()} per space per ${interval}), webhook ${url}, portal ${configuration.id}`);
console.log(`SPHR_STRIPE_PRICE_ID=${price.id}`);
console.log(`SPHR_STRIPE_WEBHOOK_SECRET=${secret}`);
console.log(`SPHR_STRIPE_PORTAL_CONFIGURATION=${configuration.id}`);
