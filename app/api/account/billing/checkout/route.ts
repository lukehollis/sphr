import { AccountError, hostingStatuses, payableSpaceCount, readCustomerSpace, readSpacePreview, readSubscription, sameTeam } from "@/lib/server/accounts-store";
import { accountRequest, accountResponse, publicOrigin } from "@/lib/server/accounts";
import { billingEnabled, startCheckout } from "@/lib/server/billing";
import { recordEvent } from "@/lib/server/analytics";
import { buildReturnPath, readUserTour } from "@/lib/server/user-tours";
import { reportProblem } from "@/lib/server/error-report";
import { readImport } from "@/lib/server/imports";

/**
 * Starts or resumes payment for waiting spaces, on the plan the customer chose (pay as you
 * go when none is named). A subscription that still exists in Stripe (for example, unpaid)
 * is repaired in the billing portal rather than duplicated.
 */
export async function POST(request: Request) {
  const { user, body, agent, error } = await accountRequest(request, 4096, { agents: true });
  if (error) return error;
  if (!billingEnabled()) return accountResponse({ error: "Billing is unavailable." }, 404);
  const subscription = readSubscription(user.id);
  if (subscription && hostingStatuses.has(subscription.status)) return accountResponse({ error: "Billing is already active." }, 409);
  // Choosing a plan to build tours, or to see a tour's class results, comes before any space; payment
  // then leads back to building, or to the results.
  const tour = typeof body?.results === "string" ? readUserTour(body.results) : undefined;
  const results = tour && sameTeam(tour.userId, user.id) ? `/account/tours/${body.results}/results` : undefined;
  const build = results ?? (body?.build === undefined ? undefined : buildReturnPath(body.build));
  // Publishing a space that is a free preview: payment returns to that space's page.
  const published = typeof body?.space === "string" ? readCustomerSpace(body.space) : undefined;
  const space = published && published.status !== "deleted" && sameTeam(published.userId, user.id) ? published : undefined;
  // Starting hosting for a list of Matterport spaces: payment returns to the list's page.
  const list = typeof body?.import === "string" ? readImport(body.import) : undefined;
  const back = list && sameTeam(list.userId, user.id) ? `/account/import/${list.id}` : undefined;
  // Without a space or the builder, only a plan covering a set number of spaces can be bought (startCheckout checks),
  // and only when it is asked for on its own: someone else's tour or space leads nowhere.
  const upfront = !build && !payableSpaceCount(user.id);
  if (upfront && (body?.plan === undefined || body.plan === null || body.results !== undefined || body.space !== undefined || body.import !== undefined)) {
    return accountResponse({ error: "Add a space first." }, 400);
  }
  try {
    const next = await startCheckout(user, publicOrigin(request), body?.plan ?? undefined, agent, build, build ? undefined : space?.id, build ? undefined : back);
    if ("url" in next) await recordEvent("checkout_started", { userId: user.id, props: { plan: next.plan, from: agent ? "agent" : body?.source === "pricing" ? "pricing" : "web",
      ...build ? { for: results ? "results" : "tours" } : back ? { for: "import" } : space ? { for: readSpacePreview(space.id) ? "preview" : "space" } : upfront ? { for: "plan" } : {} } });
    return accountResponse({ ok: true, ..."url" in next ? { url: next.url, plan: next.plan } : "portal" in next ? { url: next.portal } : { paid: true } });
  } catch (failure) {
    if (failure instanceof AccountError) return accountResponse({ error: failure.message }, 400);
    console.error("Unable to start Checkout:", failure instanceof Error ? failure.message : failure);
    await recordEvent("checkout_failed", { userId: user.id });
    reportProblem("Payment could not start", failure instanceof Error ? failure.message : String(failure), [["Account", user.email]]);
    return accountResponse({ error: "Payment could not start. Try again." }, 502);
  }
}
