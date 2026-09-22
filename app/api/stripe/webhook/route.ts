import type Stripe from "stripe";
import { recordStripeEvent, seenStripeEvent } from "@/lib/server/accounts-store";
import { accountsEnabled } from "@/lib/server/accounts";
import { billingEnabled, handleStripeEvent, stripe } from "@/lib/server/billing";

export const dynamic = "force-dynamic";

/** The body is read before its signature can be checked, so its size is capped while streaming. */
async function readLimited(request: Request, maxBytes: number) {
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  for (let length = 0; ;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString("utf8");
    length += value.length;
    if (length > maxBytes) { await reader.cancel(); return undefined; }
    chunks.push(value);
  }
}

export async function POST(request: Request) {
  if (!accountsEnabled() || !billingEnabled()) return new Response(null, { status: 404 });
  const signature = request.headers.get("stripe-signature");
  const payload = signature ? await readLimited(request, 1024 * 1024) : undefined;
  if (!signature || payload === undefined) return new Response(null, { status: 400 });
  let event: Stripe.Event;
  try { event = stripe().webhooks.constructEvent(payload, signature, process.env.SPHR_STRIPE_WEBHOOK_SECRET!.trim()); }
  catch { return new Response("Invalid signature", { status: 400 }); }
  if (seenStripeEvent(event.id)) return Response.json({ received: true });
  try { await handleStripeEvent(event); }
  catch (error) {
    // Stripe retries failed deliveries; every handler is safe to repeat.
    console.error(`Stripe event ${event.type} failed:`, error instanceof Error ? error.message : error);
    return new Response(null, { status: 500 });
  }
  recordStripeEvent(event.id);
  return Response.json({ received: true });
}
