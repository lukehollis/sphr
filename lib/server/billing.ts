import Stripe from "stripe";
import { activateUnpaidSpaces, billableSpaceCount, hostingStatuses, payableSpaceCount, readSubscription, readUser,
  saveSubscription, setCheckoutSession, setStripeCustomer, setSubscriptionQuantity, userIdForCustomer, type User } from "./accounts-store";
import { serialized } from "./serialize";

let client: Stripe | undefined;
const env = (name: string) => process.env[name]?.trim() || undefined;

export function billingEnabled() {
  return Boolean(env("SPHR_STRIPE_SECRET_KEY") && env("SPHR_STRIPE_PRICE_ID") && env("SPHR_STRIPE_WEBHOOK_SECRET"));
}

export function stripe() {
  if (client) return client;
  const key = env("SPHR_STRIPE_SECRET_KEY");
  if (!key) throw new Error("Billing is not configured.");
  // A local fake Stripe API is accepted only outside production, for tests.
  const test = process.env.NODE_ENV !== "production" && env("SPHR_STRIPE_TEST_API") ? new URL(env("SPHR_STRIPE_TEST_API")!) : undefined;
  client = new Stripe(key, { maxNetworkRetries: 2, timeout: 20000, appInfo: { name: "SPHR" },
    ...(test ? { protocol: test.protocol.replace(":", "") as "http" | "https", host: test.hostname, port: test.port } : {}) });
  return client;
}

const priceId = () => env("SPHR_STRIPE_PRICE_ID")!;
let priceCache: { value: PriceSummary; expires: number } | undefined;
export type PriceSummary = { amount: number; currency: string; interval: string; intervalCount: number };

export async function readPrice(): Promise<PriceSummary | undefined> {
  if (!billingEnabled()) return undefined;
  if (priceCache && priceCache.expires > Date.now()) return priceCache.value;
  try {
    const price = await stripe().prices.retrieve(priceId());
    if (price.unit_amount === null || !price.recurring) throw new Error("The Stripe price must be a recurring per-unit price.");
    priceCache = { value: { amount: price.unit_amount, currency: price.currency, interval: price.recurring.interval, intervalCount: price.recurring.interval_count }, expires: Date.now() + 10 * 60 * 1000 };
    return priceCache.value;
  } catch (error) {
    console.error("Unable to read the hosting price:", error instanceof Error ? error.message : error);
    return undefined;
  }
}

async function ensureCustomer(user: User) {
  if (user.stripeCustomer) return user.stripeCustomer;
  const customer = await stripe().customers.create({ email: user.email, ...(user.name ? { name: user.name } : {}), metadata: { sphr_user: user.id } },
    { idempotencyKey: `sphr-customer-${user.id}` });
  return setStripeCustomer(user.id, customer.id);
}

/** Subscriptions that still bill or can recover; a new Checkout would duplicate them. */
const liveStatuses = new Set(["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]);

export type CheckoutStart = { url: string } | { paid: true } | { portal: string };

/**
 * One Checkout for all waiting spaces, one at a time per customer. An open session is
 * reused, a paid one is applied, and a customer whose subscription still exists in Stripe
 * is sent to the billing portal instead, so a customer is never subscribed twice.
 */
export function startCheckout(user: User, origin: string): Promise<CheckoutStart> {
  return serialized(`checkout:${user.id}`, async () => {
    const current = readUser(user.id)!;
    const quantity = payableSpaceCount(current.id);
    if (!quantity) throw new Error("Add a space before paying.");
    const customer = await ensureCustomer(current);
    if (current.checkoutSession) {
      const previous = await stripe().checkout.sessions.retrieve(current.checkoutSession, { expand: ["line_items"] }).catch(() => undefined);
      if (previous?.status === "complete") {
        await applyCheckoutSession(previous.id, current.id);
        return { paid: true };
      }
      if (previous?.status === "open" && previous.url && previous.line_items?.data[0]?.quantity === quantity) return { url: previous.url };
      if (previous?.status === "open") await stripe().checkout.sessions.expire(previous.id);
    }
    const existing = (await stripe().subscriptions.list({ customer, status: "all", limit: 20 })).data.filter(item => liveStatuses.has(item.status));
    if (existing.length) {
      for (const subscription of existing) await syncSubscription(subscription.id);
      return hostingStatuses.has(readSubscription(current.id)?.status ?? "") ? { paid: true } : { portal: await portalUrl(readUser(current.id)!, origin) };
    }
    const session = await stripe().checkout.sessions.create({
      mode: "subscription", customer, client_reference_id: user.id,
      line_items: [{ price: priceId(), quantity }],
      subscription_data: { metadata: { sphr_user: user.id } },
      success_url: `${origin}/account?checkout={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/account`,
      ...(env("SPHR_STRIPE_AUTOMATIC_TAX") === "1" ? { automatic_tax: { enabled: true }, customer_update: { address: "auto" as const } } : {})
    });
    setCheckoutSession(current.id, session.id);
    return { url: session.url! };
  });
}

export async function portalUrl(user: User, origin: string) {
  const customer = await ensureCustomer(user);
  return (await stripe().billingPortal.sessions.create({ customer, return_url: `${origin}/account` })).url;
}

/** Applies a finished Checkout. Called by the webhook and when the customer returns, whichever is first. */
export async function applyCheckoutSession(id: string, expectedUser?: string) {
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return;
  const session = await stripe().checkout.sessions.retrieve(id);
  const userId = session.client_reference_id;
  if (session.mode !== "subscription" || session.status !== "complete" || !userId || (expectedUser && expectedUser !== userId)) return;
  const user = readUser(userId);
  const customer = typeof session.customer === "string" ? session.customer : session.customer?.id;
  if (!user || !customer || user.stripeCustomer !== customer) return;
  const subscription = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
  if (subscription) await syncSubscription(subscription);
  if (user.checkoutSession === id) setCheckoutSession(user.id, null);
}

/** Copies Stripe's current subscription state; event payloads may arrive out of order, so they are never trusted directly. */
export async function syncSubscription(id: string) {
  const subscription = await stripe().subscriptions.retrieve(id);
  const customer = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
  const userId = userIdForCustomer(customer);
  if (!userId || (subscription.metadata?.sphr_user && subscription.metadata.sphr_user !== userId)) return;
  // Existing customers keep the price they subscribed at when the configured price changes.
  const stored = readSubscription(userId);
  const item = subscription.items.data.find(entry => entry.id === stored?.item) ?? subscription.items.data.find(entry => entry.price.id === priceId())
    ?? subscription.items.data[0];
  if (!item) return;
  if (stored && stored.id !== subscription.id && hostingStatuses.has(stored.status) && hostingStatuses.has(subscription.status)) {
    console.error(`Customer ${userId} has two live subscriptions (${stored.id}, ${subscription.id}); keeping ${stored.id}. Cancel one in Stripe.`);
    return;
  }
  saveSubscription(userId, { id: subscription.id, item: item.id, status: subscription.status, quantity: item.quantity ?? 0,
    periodEnd: item.current_period_end ?? null, cancelAtPeriodEnd: subscription.cancel_at_period_end });
  if (hostingStatuses.has(subscription.status) && readSubscription(userId)?.id === subscription.id) {
    activateUnpaidSpaces(userId);
    await syncQuantity(userId);
  }
}

/**
 * The subscription quantity always equals the customer's hosted spaces. Updates for one
 * customer run one at a time in this single-process server; each reads the latest count.
 */
export function syncQuantity(userId: string) {
  return serialized(userId, async () => {
    const subscription = readSubscription(userId);
    if (!subscription?.item || !hostingStatuses.has(subscription.status)) return false;
    const quantity = billableSpaceCount(userId);
    if (quantity === subscription.quantity) return true;
    // Prorations are collected on the next regular invoice to avoid a card charge per space.
    const item = await stripe().subscriptionItems.update(subscription.item, { quantity, proration_behavior: "create_prorations" });
    setSubscriptionQuantity(userId, subscription.id, item.quantity ?? quantity);
    return true;
  });
}

export async function handleStripeEvent(event: Stripe.Event) {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      await applyCheckoutSession(event.data.object.id);
      break;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
      await syncSubscription(event.data.object.id);
      break;
  }
}
