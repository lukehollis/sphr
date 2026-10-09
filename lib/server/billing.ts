import Stripe from "stripe";
import { AccountError, activateUnpaidSpaces, billableSpaceCount, cancellationDate, cancellationScheduled, hostingStatuses, payableSpaceCount, readSubscription, readUser,
  saveSubscription, setCardSaved, setCheckoutSession, setStripeCustomer, setSubscriptionQuantity, userIdForCustomer, type Subscription, type SubscriptionPlan, type User } from "./accounts-store";
import { serialized } from "./serialize";
import { describePrice, notifyTeam } from "./team-notify";
import { saveEvent } from "./analytics-store";
import { contactEmail, siteBrand, siteOrigin } from "./brand";
import { cancellationScheduledEmail, hostingStoppedEmail, paymentFailedEmail, type HostingStop } from "./emails";
import { sendNotice, type MailContent } from "./mail";

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
/** Prices of plans that cover a set number of spaces for one amount, offered beside pay as you go. */
const planPriceIds = () => (env("SPHR_STRIPE_PLAN_PRICES") ?? "").split(",").map(id => id.trim()).filter(Boolean);

/**
 * A way to pay for hosting, identified by its Stripe price. Pay as you go bills each space
 * (`spaces` is null); a plan covers up to `spaces` spaces for one amount.
 */
export type Plan = { id: string; name: string; amount: number; currency: string; interval: string; intervalCount: number; spaces: number | null };
const payAsYouGoName = "Pay as you go";

/** Plan prices record how many spaces they cover in their metadata. Any other price bills per space. */
function coveredSpaces(price: Stripe.Price) {
  if (price.id === priceId()) return null;
  const spaces = Number(price.metadata?.sphr_spaces);
  return Number.isInteger(spaces) && spaces > 0 ? spaces : null;
}

function toPlan(price: Stripe.Price): Plan | undefined {
  const spaces = coveredSpaces(price);
  if (price.unit_amount === null || !price.recurring || !price.active) {
    console.error(`Hosting price ${price.id} must be an active recurring price with a fixed amount.`);
    return undefined;
  }
  if (price.id !== priceId() && spaces === null) {
    console.error(`Plan price ${price.id} needs the metadata sphr_spaces, the number of spaces it covers.`);
    return undefined;
  }
  const product = typeof price.product === "object" && !price.product.deleted ? price.product : undefined;
  return { id: price.id, name: spaces === null ? payAsYouGoName : product?.name || price.nickname || `Up to ${spaces} spaces`,
    amount: price.unit_amount, currency: price.currency, interval: price.recurring.interval, intervalCount: price.recurring.interval_count, spaces };
}

let plansCache: { value: Plan[]; expires: number } | undefined;

/**
 * Pay as you go first, then the plans from the smallest. Amounts and names come from Stripe,
 * so changing a price needs no rebuild. Empty when billing is off or Stripe cannot be reached.
 */
export async function readPlans(): Promise<Plan[]> {
  if (!billingEnabled()) return [];
  if (plansCache && plansCache.expires > Date.now()) return plansCache.value;
  const results = await Promise.allSettled([priceId(), ...planPriceIds()].map(id => stripe().prices.retrieve(id, { expand: ["product"] })));
  const failed = results.find(result => result.status === "rejected");
  if (failed) console.error("Unable to read a hosting price:", failed.reason instanceof Error ? failed.reason.message : failed.reason);
  const plans = results.map(result => result.status === "fulfilled" ? toPlan(result.value) : undefined);
  const [perSpace, ...fixed] = plans;
  if (!perSpace || perSpace.spaces !== null) return plansCache?.value ?? [];
  const value = [perSpace, ...fixed.filter((plan): plan is Plan => Boolean(plan)).sort((a, b) => a.spaces! - b.spaces! || a.amount - b.amount)];
  // A price that could not be read is retried sooner.
  plansCache = { value, expires: Date.now() + (failed ? 60 * 1000 : 10 * 60 * 1000) };
  return value;
}

/** The plan a customer chose, or pay as you go when none is named. */
async function resolvePlan(id: unknown): Promise<Plan> {
  if (id === undefined || id === null || id === "" || id === priceId()) {
    return (await readPlans())[0] ?? { id: priceId(), name: payAsYouGoName, amount: 0, currency: "usd", interval: "month", intervalCount: 1, spaces: null };
  }
  const plan = typeof id === "string" ? (await readPlans()).find(item => item.id === id) : undefined;
  if (!plan) throw new AccountError("That plan is not offered any more. Reload the page and choose again.");
  return plan;
}

function subscriptionPlan(price: Stripe.Price): SubscriptionPlan {
  return { price: price.id, amount: price.unit_amount, currency: price.currency, interval: price.recurring?.interval ?? "month",
    intervalCount: price.recurring?.interval_count ?? 1, spaces: coveredSpaces(price) };
}

async function ensureCustomer(user: User) {
  if (user.stripeCustomer) return user.stripeCustomer;
  const customer = await stripe().customers.create({ email: user.email, ...(user.name ? { name: user.name } : {}), metadata: { sphr_user: user.id } },
    { idempotencyKey: `sphr-customer-${user.id}` });
  return setStripeCustomer(user.id, customer.id);
}

/** Subscriptions that still bill or can recover; a new Checkout would duplicate them. */
const liveStatuses = new Set(["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]);

/** A Checkout to open (with the plan it pays for), a payment already applied, or the portal to repair billing. */
export type CheckoutStart = { url: string; plan: string } | { paid: true } | { portal: string };

/**
 * One Checkout for all waiting spaces, one at a time per customer. An open session is
 * reused, a paid one is applied, and a customer whose subscription still exists in Stripe
 * is sent to the billing portal instead, so a customer is never subscribed twice. Without
 * a plan named, an open session keeps its plan while that plan still covers every space.
 */
export function startCheckout(user: User, origin: string, planId?: unknown, fromAgent = false, build?: string): Promise<CheckoutStart> {
  return serialized(`checkout:${user.id}`, async () => {
    const current = readUser(user.id)!;
    const count = payableSpaceCount(current.id);
    if (!count && !build) throw new AccountError("Add a space before paying.");
    const customer = await ensureCustomer(current);
    // Someone choosing a plan to build tours, before any space of their own. Pay as you go
    // costs nothing yet, so Checkout only saves a card; a plan starts its subscription now.
    const back = build && `${origin}${build}${build.includes("?") ? "&" : "?"}checkout={CHECKOUT_SESSION_ID}`;
    if (!count && build) {
      const plan = await resolvePlan(planId);
      if (plan.spaces === null) {
        const session = await stripe().checkout.sessions.create({
          mode: "setup", customer, client_reference_id: user.id, currency: plan.currency,
          setup_intent_data: { metadata: { sphr_user: user.id } },
          success_url: back!, cancel_url: `${origin}${planPath(build)}`
        });
        return { url: session.url!, plan: plan.id };
      }
      if ((await stripe().subscriptions.list({ customer, status: "all", limit: 20 })).data.some(item => liveStatuses.has(item.status))) {
        return { portal: await portalUrl(current, origin) };
      }
      const session = await stripe().checkout.sessions.create({
        mode: "subscription", customer, client_reference_id: user.id,
        line_items: [{ price: plan.id, quantity: 1 }],
        subscription_data: { metadata: { sphr_user: user.id } },
        success_url: back!, cancel_url: `${origin}${planPath(build)}`,
        ...(env("SPHR_STRIPE_AUTOMATIC_TAX") === "1" ? { automatic_tax: { enabled: true }, customer_update: { address: "auto" as const } } : {})
      });
      return { url: session.url!, plan: plan.id };
    }
    const previous = current.checkoutSession
      ? await stripe().checkout.sessions.retrieve(current.checkoutSession, { expand: ["line_items"] }).catch(() => undefined) : undefined;
    if (previous?.status === "complete") {
      await applyCheckoutSession(previous.id, current.id);
      return { paid: true };
    }
    const open = previous?.status === "open" ? previous : undefined;
    const openLine = open?.line_items?.data[0];
    const chosen = planId ?? openLine?.price?.id;
    let plan = await resolvePlan(chosen).catch(error => { if (planId === undefined) return resolvePlan(undefined); throw error; });
    if (plan.spaces !== null && count > plan.spaces) {
      if (planId !== undefined) throw new AccountError(`${plan.name} covers up to ${plan.spaces} spaces. Choose a larger plan or pay as you go.`);
      plan = await resolvePlan(undefined);
    }
    const quantity = plan.spaces === null ? count : 1;
    if (open?.url && openLine?.quantity === quantity && openLine.price?.id === plan.id) return { url: open.url, plan: plan.id };
    if (open) await stripe().checkout.sessions.expire(open.id);
    const existing = (await stripe().subscriptions.list({ customer, status: "all", limit: 20 })).data.filter(item => liveStatuses.has(item.status));
    if (existing.length) {
      for (const subscription of existing) await syncSubscription(subscription.id);
      return hostingStatuses.has(readSubscription(current.id)?.status ?? "") ? { paid: true } : { portal: await portalUrl(readUser(current.id)!, origin) };
    }
    const session = await stripe().checkout.sessions.create({
      mode: "subscription", customer, client_reference_id: user.id,
      line_items: [{ price: plan.id, quantity }],
      subscription_data: { metadata: { sphr_user: user.id } },
      // An agent is waiting to upload; the page tells the customer to go back to it.
      success_url: back || `${origin}/account?checkout={CHECKOUT_SESSION_ID}${fromAgent ? "&agent=1" : ""}`,
      cancel_url: `${origin}/account`,
      ...(env("SPHR_STRIPE_AUTOMATIC_TAX") === "1" ? { automatic_tax: { enabled: true }, customer_update: { address: "auto" as const } } : {})
    });
    setCheckoutSession(current.id, session.id);
    return { url: session.url!, plan: plan.id };
  });
}

export async function portalUrl(user: User, origin: string) {
  const customer = await ensureCustomer(user);
  const configuration = env("SPHR_STRIPE_PORTAL_CONFIGURATION");
  return (await stripe().billingPortal.sessions.create({ customer, return_url: `${origin}/account`, ...(configuration ? { configuration } : {}) })).url;
}

/** Applies a finished Checkout. Called by the webhook and when the customer returns, whichever is first. */
export async function applyCheckoutSession(id: string, expectedUser?: string) {
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return;
  const session = await stripe().checkout.sessions.retrieve(id);
  const userId = session.client_reference_id;
  if (session.mode === "setup") return applySavedCard(session, expectedUser);
  if (session.mode !== "subscription" || session.status !== "complete" || !userId || (expectedUser && expectedUser !== userId)) return;
  const user = readUser(userId);
  const customer = typeof session.customer === "string" ? session.customer : session.customer?.id;
  if (!user || !customer || user.stripeCustomer !== customer) return;
  const subscription = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
  if (subscription) await syncSubscription(subscription);
  if (user.checkoutSession === id) setCheckoutSession(user.id, null);
}

/** A card saved to build tours on pay as you go becomes the customer's default, so hosting a space later reuses it. */
async function applySavedCard(session: Stripe.Checkout.Session, expectedUser?: string) {
  const userId = session.client_reference_id;
  if (session.status !== "complete" || !userId || (expectedUser && expectedUser !== userId)) return;
  const user = readUser(userId);
  const customer = typeof session.customer === "string" ? session.customer : session.customer?.id;
  if (!user || !customer || user.stripeCustomer !== customer) return;
  if (user.cardSaved) return;
  const intentId = typeof session.setup_intent === "string" ? session.setup_intent : session.setup_intent?.id;
  const intent = intentId ? await stripe().setupIntents.retrieve(intentId) : undefined;
  const method = typeof intent?.payment_method === "string" ? intent.payment_method : intent?.payment_method?.id;
  if (intent?.status !== "succeeded" || !method) return;
  await stripe().customers.update(customer, { invoice_settings: { default_payment_method: method } });
  setCardSaved(user.id);
  saveEvent("card_saved", { userId: user.id, props: { for: "tours" } });
  void notifyTeam({ title: "Card saved to build tours", tone: "money", fields: [["Account", user.email]] });
}

/** The plan page that leads back to building, for a Checkout left early. */
function planPath(build: string) {
  const scene = /[?&]scene=([a-f0-9]{12})/.exec(build)?.[1];
  return `/account/plan?build=${scene ?? "1"}`;
}

/** The account a Stripe subscription belongs to: its customer's, unless its metadata names another account. */
function subscriptionUser(subscription: Stripe.Subscription) {
  const userId = userIdForCustomer(typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id);
  return userId && !(subscription.metadata?.sphr_user && subscription.metadata.sphr_user !== userId) ? userId : undefined;
}

/**
 * Copies Stripe's current subscription state; event payloads may arrive out of order, so they are
 * never trusted directly. A first read finds the account; the state that is saved is read again
 * under that account's lock, so a sync that read Stripe earlier can never save an older state over
 * a newer one (and have the next event announce the same change again).
 */
export async function syncSubscription(id: string) {
  const userId = subscriptionUser(await stripe().subscriptions.retrieve(id));
  if (!userId) return;
  await serialized(`subscription:${userId}`, async () => {
    const subscription = await stripe().subscriptions.retrieve(id);
    if (subscriptionUser(subscription) !== userId) return;
    // Existing customers keep the price they subscribed at when the configured prices change.
    const stored = readSubscription(userId);
    const offered = new Set([priceId(), ...planPriceIds()]);
    const item = subscription.items.data.find(entry => entry.id === stored?.item) ?? subscription.items.data.find(entry => offered.has(entry.price.id))
      ?? subscription.items.data[0];
    if (!item) return;
    if (stored && stored.id !== subscription.id && hostingStatuses.has(stored.status) && hostingStatuses.has(subscription.status)) {
      console.error(`Customer ${userId} has two live subscriptions (${stored.id}, ${subscription.id}); keeping ${stored.id}. Cancel one in Stripe.`);
      return;
    }
    const next = { id: subscription.id, item: item.id, status: subscription.status, quantity: item.quantity ?? 0,
      periodEnd: item.current_period_end ?? null, cancelAtPeriodEnd: subscription.cancel_at_period_end, cancelAt: subscription.cancel_at ?? null,
      plan: subscriptionPlan(item.price) };
    const { saved, previous } = saveSubscription(userId, next);
    if (saved) {
      void announceBillingChange(userId, previous, next)
        .catch(error => console.error(`Unable to announce a billing change for account ${userId}:`, error instanceof Error ? error.message : error));
    }
    // Quantity updates take the account's own lock (`userId`), never this one, so they cannot wait on each other.
    if (hostingStatuses.has(subscription.status) && readSubscription(userId)?.id === subscription.id) {
      activateUnpaidSpaces(userId);
      await syncQuantity(userId);
    }
  });
}

/**
 * Tells the operator when hosting starts, changes plan, stops paying, is cancelled or ends, and
 * tells the customer when a payment fails, a cancellation is scheduled or hosting stops. Each
 * change is seen once: `saveSubscription` compares Stripe's state with the saved copy in one
 * transaction, and syncs for one account run one at a time, so repeated events, redelivered
 * webhooks and returns from Checkout say nothing. Customers without spaces (a plan taken to
 * build tours) are not told that spaces went offline; the account page says nothing then either.
 */
async function announceBillingChange(userId: string, previous: Subscription | undefined, next: Subscription) {
  const user = readUser(userId);
  const email = user?.email ?? userId;
  const plans = await readPlans().catch(() => []);
  const price = describePrice(next.plan, plans);
  const spaces = payableSpaceCount(userId);
  const tell = (content: MailContent) => { if (user) void sendNotice(user.email, content, user.id); };
  const wasHosting = Boolean(previous && previous.id === next.id && hostingStatuses.has(previous.status));
  const hosting = hostingStatuses.has(next.status);
  const fields: [string, string | number | null][] = [["Account", email], ["Plan", price], ["Status", next.status]];
  if (!wasHosting && hosting) {
    saveEvent("subscription_started", { userId, props: { plan: next.plan?.price ?? "", amount: next.plan?.amount ?? 0, spaces: next.quantity } });
    return notifyTeam({ title: "New subscription", tone: "money", fields: [...fields, ["Spaces billed", next.plan?.spaces ? null : next.quantity]] });
  }
  if (!previous || previous.id !== next.id) return;
  if (wasHosting && !hosting) {
    saveEvent("subscription_ended", { userId, props: { status: next.status } });
    // As the account page does: a subscription that still exists unpaid is repaired with a new payment
    // method, an ended one by restarting billing. A plan whose cancellation was scheduled ended as asked.
    const fix: HostingStop["fix"] = ["unpaid", "incomplete", "paused"].includes(next.status) ? "payment" : "restart";
    const why: HostingStop["why"] = cancellationScheduled(previous) && next.status === "canceled" ? "cancelled"
      : previous.status === "past_due" || fix === "payment" ? "unpaid" : "ended";
    if (spaces) tell(hostingStoppedEmail(siteBrand(), siteOrigin(), contactEmail(), { why, fix }, price));
    return notifyTeam({ title: "Hosting stopped", tone: "bad", description: `The subscription is now ${next.status}, so this account's spaces are offline.`, fields });
  }
  if (previous.status !== "past_due" && next.status === "past_due") {
    tell(paymentFailedEmail(siteBrand(), siteOrigin(), contactEmail(), { plan: price, spaces }));
    return notifyTeam({ title: "Payment failed", tone: "warn", description: "Stripe is retrying the payment; spaces stay online meanwhile.", fields });
  }
  if (previous.plan?.price !== next.plan?.price && hosting) {
    return notifyTeam({ title: "Plan changed", tone: "money", fields: [["Account", email], ["From", describePrice(previous.plan, plans)], ["To", price]] });
  }
  const ends = cancellationDate(next);
  if (!cancellationScheduled(previous) && cancellationScheduled(next)) {
    // A payment still overdue means the period is not paid for; the email does not claim it is.
    if (hosting) tell(cancellationScheduledEmail(siteBrand(), siteOrigin(), contactEmail(), { ends, paid: next.status !== "past_due", spaces, plan: price }));
    return notifyTeam({ title: "Cancellation scheduled", tone: "warn",
      fields: [...fields, ["Ends", ends ? new Date(ends * 1000).toISOString().slice(0, 10) : null]] });
  }
  if (cancellationScheduled(previous) && !cancellationScheduled(next) && hosting) return notifyTeam({ title: "Cancellation withdrawn", tone: "good", fields });
}

/**
 * On pay as you go the subscription quantity always equals the customer's hosted spaces;
 * a plan is one unit. Updates for one customer run one at a time in this single-process
 * server; each reads the latest count.
 */
export function syncQuantity(userId: string) {
  return serialized(userId, async () => {
    const subscription = readSubscription(userId);
    if (!subscription?.item || !hostingStatuses.has(subscription.status)) return false;
    const quantity = subscription.plan?.spaces ? 1 : billableSpaceCount(userId);
    if (quantity === subscription.quantity) return true;
    // Prorations are collected on the next regular invoice to avoid a card charge per space.
    const item = await stripe().subscriptionItems.update(subscription.item, { quantity, proration_behavior: "create_prorations" });
    setSubscriptionQuantity(userId, subscription.id, item.quantity ?? quantity);
    return true;
  });
}

/**
 * Moves a hosting subscription to another plan at once. As with adding a space, the
 * difference is prorated onto the next regular invoice: Stripe Managed Payments does not
 * allow invoices outside the billing period. A plan must cover every space the customer has.
 */
export async function changePlan(user: User, planId: unknown) {
  const plan = await resolvePlan(planId);
  const changed = await serialized(user.id, async () => {
    const subscription = readSubscription(user.id);
    if (!subscription?.item || !hostingStatuses.has(subscription.status)) throw new AccountError("Start hosting before changing plans.");
    if (subscription.plan?.price === plan.id) return undefined;
    const count = payableSpaceCount(user.id);
    if (plan.spaces !== null && count > plan.spaces) {
      throw new AccountError(`${plan.name} covers up to ${plan.spaces} spaces and you have ${count}. Delete spaces or choose a larger plan.`);
    }
    await stripe().subscriptions.update(subscription.id, {
      items: [{ id: subscription.item, price: plan.id, quantity: plan.spaces === null ? billableSpaceCount(user.id) : 1 }],
      proration_behavior: "create_prorations"
    });
    return subscription.id;
  });
  if (changed) await syncSubscription(changed);
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
