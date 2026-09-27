#!/usr/bin/env node
// Creates or updates the Stripe objects hosting needs, in the mode of the key given (test or live):
// the "Pay as you go" product with a monthly per-space price, one product and monthly price for
// each plan that covers a set number of spaces, the webhook endpoint and a billing portal
// configuration without quantity or plan changes. Safe to run again.
//   SPHR_STRIPE_SECRET_KEY=sk_… node scripts/deploy/stripe-setup.mjs --origin https://app.example.com \
//     [--amount 200] [--currency usd] [--plans starter:800:6,pro:5000:30,enterprise:24900:200]
// Plans are name:cents:spaces; pass --plans none to offer only pay as you go.
// Prints KEY=VALUE lines for the application environment. SPHR_STRIPE_WEBHOOK_SECRET, when set,
// keeps the existing endpoint; otherwise the endpoint is recreated to obtain a new secret.
import Stripe from 'stripe';

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map(part => part.trim().split(/\s+/)));
const key = process.env.SPHR_STRIPE_SECRET_KEY?.trim();
const origin = (args.origin ?? '').replace(/\/$/, '');
const amount = Number(args.amount ?? 200), currency = (args.currency ?? 'usd').toLowerCase(), interval = 'month';
const planList = args.plans ?? 'starter:800:6,pro:5000:30,enterprise:24900:200';
const plans = planList === 'none' ? [] : planList.split(',').map(entry => {
  const [name, cents, spaces] = entry.split(':');
  return { key: name?.toLowerCase(), name: name ? name[0].toUpperCase() + name.slice(1) : '', amount: Number(cents), spaces: Number(spaces) };
});
if (!key || !/^(sk|rk)_(test|live)_/.test(key)) { console.error('Set SPHR_STRIPE_SECRET_KEY to a Stripe secret key.'); process.exit(1); }
if (!/^https:\/\/[^/]+$/.test(origin)) { console.error('Pass --origin with the application\'s HTTPS origin.'); process.exit(1); }
if (!Number.isInteger(amount) || amount < 50) { console.error('--amount is in the smallest currency unit, at least 50.'); process.exit(1); }
if (plans.some(plan => !/^[a-z][a-z0-9-]{0,30}$/.test(plan.key ?? '') || !Number.isInteger(plan.amount) || plan.amount < 50 || !Number.isInteger(plan.spaces) || plan.spaces < 1)) {
  console.error('--plans is a comma-separated list of name:cents:spaces, for example starter:800:6.'); process.exit(1);
}
const stripe = new Stripe(key);
const mode = key.includes('_live_') ? 'live' : 'test';

// "Website Hosting": required by Stripe Managed Payments and used by Stripe Tax.
const taxCode = 'txcd_10701100';
const activeProducts = (await stripe.products.list({ limit: 100, active: true })).data;
async function ensureProduct(tag, name, description) {
  const found = activeProducts.find(item => item.metadata?.sphr === tag);
  const product = found ?? await stripe.products.create({ name, description, tax_code: taxCode, metadata: { sphr: tag } });
  const code = typeof product.tax_code === 'string' ? product.tax_code : product.tax_code?.id;
  return product.name !== name || product.description !== description || code !== taxCode
    ? stripe.products.update(product.id, { name, description, tax_code: taxCode }) : product;
}
async function ensurePrice(product, lookup, unitAmount, nickname, metadata) {
  const found = (await stripe.prices.list({ lookup_keys: [lookup], active: true, limit: 1 })).data[0];
  const price = found ?? await stripe.prices.create({ product: product.id, currency, unit_amount: unitAmount, lookup_key: lookup,
    recurring: { interval, usage_type: 'licensed' }, nickname, metadata });
  // Prices are immutable apart from metadata and nickname; keep both current.
  return Object.entries(metadata).some(([name, value]) => price.metadata?.[name] !== value) || price.nickname !== nickname
    ? stripe.prices.update(price.id, { metadata, nickname }) : price;
}

// Pay as you go: the quantity is the number of spaces. The product keeps its original tag so
// existing subscriptions stay on it.
const perSpaceProduct = await ensureProduct('space-hosting', 'Pay as you go', 'Hosting for each space, billed per space.');
const perSpace = await ensurePrice(perSpaceProduct, `sphr-space-${interval}-${currency}-${amount}`, amount,
  `Pay as you go, ${amount / 100} ${currency.toUpperCase()} per space per ${interval}`, { sphr_plan: 'pay-as-you-go' });

// Plans: one unit covers up to `spaces` spaces. The application reads the limit from sphr_spaces.
const planPrices = [];
for (const plan of plans) {
  const product = await ensureProduct(`plan-${plan.key}`, plan.name, `Hosting for up to ${plan.spaces} spaces.`);
  planPrices.push(await ensurePrice(product, `sphr-plan-${plan.key}-${interval}-${currency}-${plan.amount}-${plan.spaces}`, plan.amount,
    `${plan.name}, up to ${plan.spaces} spaces, ${plan.amount / 100} ${currency.toUpperCase()} per ${interval}`,
    { sphr_plan: plan.key, sphr_spaces: String(plan.spaces) }));
}

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
    // Pay as you go follows the number of spaces and plans change in the application, which checks
    // that a plan covers every space.
    subscription_update: { enabled: false }
  }
};
const existing = (await stripe.billingPortal.configurations.list({ limit: 100, active: true })).data.find(item => item.metadata?.sphr === 'space-hosting');
const configuration = existing ? await stripe.billingPortal.configurations.update(existing.id, portal)
  : await stripe.billingPortal.configurations.create({ ...portal, metadata: { sphr: 'space-hosting' } });

console.error(`Stripe ${mode} mode: pay as you go ${perSpace.id} (${amount / 100} ${currency.toUpperCase()} per space per ${interval})`
  + plans.map((plan, index) => `, ${plan.name} ${planPrices[index].id} (${plan.amount / 100} ${currency.toUpperCase()} for up to ${plan.spaces} spaces)`).join('')
  + `, webhook ${url}, portal ${configuration.id}`);
console.log(`SPHR_STRIPE_PRICE_ID=${perSpace.id}`);
console.log(`SPHR_STRIPE_PLAN_PRICES=${planPrices.map(price => price.id).join(',')}`);
console.log(`SPHR_STRIPE_WEBHOOK_SECRET=${secret}`);
console.log(`SPHR_STRIPE_PORTAL_CONFIGURATION=${configuration.id}`);
