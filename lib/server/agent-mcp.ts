import { allowAttempt } from "./admin-store";
import { claimAgentLink, createAgentLink, deleteAgentToken, saveMcpSecret, userFromAgentToken, type McpSecret } from "./accounts-store";
import { attemptKey, clientAddress, publicOrigin } from "./accounts";
import { siteBrand } from "./brand";
import { GET as listSpacesRoute, POST as addSpaceRoute } from "@/app/api/account/spaces/route";
import { GET as readSpaceRoute, PATCH as editSpaceRoute } from "@/app/api/account/spaces/[id]/route";
import { POST as addUploadRoute } from "@/app/api/account/spaces/[id]/uploads/route";
import { POST as submitRoute } from "@/app/api/account/spaces/[id]/submit/route";
import { POST as completeUploadRoute } from "@/app/api/account/uploads/[id]/complete/route";
import { POST as checkoutRoute } from "@/app/api/account/billing/checkout/route";
import { GET as plansRoute } from "@/app/api/account/billing/plans/route";

// Tools for agents that run in the cloud (Meta Muse, claude.ai, ChatGPT and other apps that take a
// connector URL). They cannot read the person's disk, so they either upload files they hold
// themselves, in the same resumable chunks the browser uses, or send the person to the space's page
// to drop the files. Every call runs the account routes in-process with the agent's token, so
// limits, billing and validation are the browser's own.

export type McpContext = { request: Request; client: string; token?: string; sessionId?: string; secret: McpSecret };
type Tool = { name: string; description: string; inputSchema: object; run: (args: Record<string, unknown>, context: McpContext) => Promise<string> };

class Problem extends Error {
  constructor(message: string, public status?: number, public data?: Record<string, unknown>) { super(message); }
}

const spaceIdSchema = { type: "string", description: "The space ID (12 hexadecimal characters) from create_space or space_status." };
const linkWait = 25000;
const paymentWait = 25000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function formatBytes(bytes: number) {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = bytes, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return unit ? `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}` : `${bytes} bytes`;
}

function money(amount: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(amount / 100);
}

/** Runs an account route as the linked agent. */
async function call(context: McpContext, handler: (request: Request, extra: never) => Promise<Response>, path: string,
  { method = "GET", body, id }: { method?: string; body?: object; id?: string } = {}) {
  if (!context.token) throw new Problem(`This agent is not linked to a ${siteBrand()} account yet. Call link_account first.`, 401);
  const url = new URL(path, publicOrigin(context.request));
  const request = new Request(url, { method, headers: { Authorization: `Bearer ${context.token}`, ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
    "X-Real-IP": context.request.headers.get("x-real-ip") ?? "local" }, body: method !== "GET" ? JSON.stringify(body ?? {}) : undefined });
  const response = await handler(request, { params: Promise.resolve({ id: id ?? "" }) } as never);
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (response.status === 401) {
    if (context.sessionId) saveMcpSecret(context.sessionId, {});
    throw new Problem(`This agent is no longer linked to the account. Call link_account to link it again.`, 401);
  }
  if (!response.ok) throw new Problem(String(data.error ?? `The request failed with HTTP ${response.status}.`), response.status, data);
  return data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const spacePage = (context: McpContext, id: string) => `${publicOrigin(context.request)}/account/spaces/${id}`;
const statusText: Record<string, string> = { unpaid: "waiting for payment", draft: "waiting for files", queued: "submitted and waiting for a processing agent",
  processing: "being processed", ready: "ready", failed: "needs attention" };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function describeSpace(context: McpContext, space: any) {
  const parts = [`${JSON.stringify(space.title)} (space_id ${space.id}) is ${statusText[space.status] ?? space.status}`];
  if (space.status === "ready" && space.scene) parts.push(`at ${publicOrigin(context.request)}${space.scene.path}, ${space.scene.public ? "public" : "private (only the owner can open it)"}`);
  if (space.job?.progress && ["queued", "processing"].includes(space.status)) parts.push(`latest step ${JSON.stringify(space.job.progress)}`);
  if (space.message && ["failed", "ready"].includes(space.status)) parts.push(`message ${JSON.stringify(space.message)}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const uploads = (space.uploads as any[]).filter(upload => upload.status !== "deleted");
  if (uploads.length) parts.push(`${uploads.filter(upload => upload.status === "complete").length} of ${uploads.length} files uploaded`);
  let line = `${parts.join(", ")}.`;
  if (["draft", "failed"].includes(space.status)) line += ` The person can drop files at ${spacePage(context, space.id)}.`;
  if (["queued", "processing"].includes(space.status)) line += ` ${siteBrand()} emails the account when it is ready.`;
  return line;
}

async function linkAccount(args: Record<string, unknown>, context: McpContext) {
  const brand = siteBrand();
  if (context.token) {
    const user = userFromAgentToken(context.token);
    if (user) return `Already linked to the ${brand} account ${user.email}.`;
    if (context.sessionId) saveMcpSecret(context.sessionId, {});
  }
  // Sessions keep the link code; an agent without one passes back the link_code it was given.
  let code = context.secret.link ?? (typeof args.link_code === "string" ? args.link_code : undefined);
  if (!code) {
    if (!allowAttempt([[attemptKey("agent-link", clientAddress(context.request)), 30]], 60 * 60 * 1000)) throw new Problem("Too many link requests. Try again later.");
    const link = createAgentLink(context.client);
    if (context.sessionId) saveMcpSecret(context.sessionId, { link: link.code });
    const url = `${publicOrigin(context.request)}/account/connect/${link.userCode}`;
    return [`Give the person this link to approve this agent ${url}`,
      `They sign in to ${brand} (or create an account) and click Link agent after checking that the page shows the code ${link.userCode}.`,
      "Never ask them for a password. When they say they have approved it, call link_account again.",
      context.sessionId ? "" : `Pass link_code ${JSON.stringify(link.code)} when you call it again.`].filter(Boolean).join(" ");
  }
  const deadline = Date.now() + linkWait;
  for (;;) {
    const result = claimAgentLink(code);
    if (result.status === "approved") {
      if (context.sessionId) {
        saveMcpSecret(context.sessionId, { token: result.token });
        return `Linked to the ${brand} account ${result.user.email}.${result.user.emailVerified ? "" : " The email address is not confirmed yet, so ask the person to click the link in the confirmation email before creating a space."}`;
      }
      return [`Linked to the ${brand} account ${result.user.email}.`,
        `This connection has no session, so keep this token as a secret and send it on every request as the header Authorization: Bearer ${result.token}`,
        "Do not show it to anyone. The person can unlink it from their account page."].join(" ");
    }
    if (result.status === "expired") {
      if (context.sessionId) saveMcpSecret(context.sessionId, {});
      throw new Problem("The link code expired before it was approved. Call link_account again for a new link.");
    }
    if (Date.now() > deadline) return "The person has not approved the link yet. Ask them to open the link and click Link agent, then call link_account again.";
    await sleep(2000);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function describePlan(plan: any) {
  const price = `${money(plan.amount, plan.currency)} a ${plan.intervalCount > 1 ? `${plan.intervalCount} ${plan.interval}s` : plan.interval}`;
  return plan.spaces === null ? `${plan.name}, ${price} for each space (id ${plan.id})` : `${plan.name}, ${price} for up to ${plan.spaces} spaces (id ${plan.id})`;
}

async function listPlans(_args: Record<string, unknown>, context: McpContext) {
  const { plans, account } = await call(context, plansRoute as never, "/api/account/billing/plans");
  if (!account.billing) return "Hosting on this site needs no payment.";
  const current = account.subscription && ["active", "trialing", "past_due"].includes(account.subscription.status) ? account.subscription : undefined;
  return [current ? `The account already pays for hosting (${current.plan?.spaces ? `a plan for up to ${current.plan.spaces} spaces` : "pay as you go"}, ${account.spaceCount} spaces), so new spaces need no checkout.`
    : "The account does not pay for hosting yet. The first space needs a Stripe Checkout for one of these, pay as you go unless the person picks a plan.",
  ...plans.map(describePlan), "Plans can be changed later on the plan page of the account."].join("\n");
}

async function createSpace(args: Record<string, unknown>, context: McpContext) {
  let chosen: string | undefined;
  if (typeof args.plan === "string" && args.plan.trim()) {
    const { plans } = await call(context, plansRoute as never, "/api/account/billing/plans");
    const wanted = args.plan.trim().toLowerCase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plan = (plans as any[]).find(item => item.id.toLowerCase() === wanted || item.name.toLowerCase() === wanted) ?? (plans as any[]).find(item => item.name.toLowerCase().includes(wanted));
    if (!plan) throw new Problem(`No plan is called ${args.plan}. The plans are ${(plans as { name: string }[]).map(item => item.name).join(", ")}.`);
    chosen = plan.id;
  }
  let created;
  try { created = await call(context, addSpaceRoute as never, "/api/account/spaces", { method: "POST", body: { title: args.title } }); }
  catch (error) {
    if (error instanceof Problem && error.data?.planFull) throw new Problem(`${error.message} Give the person the plan page ${publicOrigin(context.request)}/account/plan to move to a larger plan, then call create_space again.`);
    throw error;
  }
  const space = created.space;
  let checkout = created.checkout as string | undefined;
  if (chosen && checkout && created.plan !== chosen) checkout = (await call(context, checkoutRoute as never, "/api/account/billing/checkout", { method: "POST", body: { plan: chosen } })).url;
  const lines = [`Created the space ${JSON.stringify(space.title)} (space_id ${space.id}).`];
  if (checkout) lines.push(`Hosting needs payment before files can upload. Give the person this Stripe Checkout link ${checkout} and ask them to pay there (never ask for card details), then call wait_for_payment.`);
  else if (created.portal) lines.push(`Billing needs attention first. Give the person this link ${created.portal}, then call wait_for_payment.`);
  else if (space.status === "unpaid") lines.push(`${created.error ?? "Payment could not start."} Call wait_for_payment, which tries again.`);
  else lines.push(`It is ready for files. Upload files you hold with upload_files, or give the person ${spacePage(context, space.id)} to drop files from their own device.`);
  return lines.join(" ");
}

async function waitForPayment(args: Record<string, unknown>, context: McpContext) {
  const id = String(args.space_id ?? "");
  const deadline = Date.now() + paymentWait;
  let nudged = false;
  for (;;) {
    const { space } = await call(context, readSpaceRoute as never, `/api/account/spaces/${id}`, { id });
    if (space.status !== "unpaid" && space.hosted) return `Payment received. The space is ready for files. Upload files you hold with upload_files, or give the person ${spacePage(context, id)} to drop files from their own device.`;
    if (!nudged && Date.now() > deadline - paymentWait / 2) {
      nudged = true;
      // Applies a finished Checkout even before Stripe's webhook arrives.
      const result = await call(context, checkoutRoute as never, "/api/account/billing/checkout", { method: "POST" }).catch(() => undefined);
      if (result?.url && Date.now() + 5000 > deadline) return `Still waiting. If the Checkout page was closed, give the person this link ${result.url} and call wait_for_payment again.`;
    }
    if (Date.now() > deadline) return "Still waiting for payment. Ask the person whether they finished paying, then call wait_for_payment again.";
    await sleep(2500);
  }
}

async function uploadFiles(args: Record<string, unknown>, context: McpContext) {
  const id = String(args.space_id ?? "");
  const files = Array.isArray(args.files) ? args.files as { name?: unknown; size?: unknown; type?: unknown }[] : [];
  if (!files.length || files.length > 500) throw new Problem("List 1 to 500 files, each with its name and size in bytes.");
  const started = [];
  for (const file of files) {
    const result = await call(context, addUploadRoute as never, `/api/account/spaces/${id}/uploads`, { method: "POST", id,
      body: { name: file.name, size: file.size, ...(typeof file.type === "string" ? { type: file.type } : {}) } });
    const url = new URL(result.url, publicOrigin(context.request));
    started.push({ name: result.upload.name, size: result.upload.size, upload_id: result.upload.id, url: url.href, chunk_size: result.chunkSize,
      ...(url.origin === publicOrigin(context.request) ? { note: "This URL is on the site itself, so send the same Authorization header." } : {}) });
  }
  return [`Started ${started.length} upload${started.length === 1 ? "" : "s"}. For each file, send its bytes with HTTP PUT to its url in pieces of chunk_size bytes`,
    "(the last piece may be smaller), in order, each with the header Content-Range bytes START-END/SIZE (END is inclusive).",
    "HTTP 308 means send the next piece; its Range header (bytes=0-N) says N+1 bytes are stored, so resume from there after an error. HTTP 200 or 201 means the file is complete.",
    "When every file is sent, call finish_upload to check them and submit the space for processing.",
    `If the files are on the person's own computer or phone instead, give them ${spacePage(context, id)} to drop them there.`,
    JSON.stringify(started, null, 2)].join(" ");
}

async function finishUpload(args: Record<string, unknown>, context: McpContext) {
  const id = String(args.space_id ?? "");
  const { space } = await call(context, readSpaceRoute as never, `/api/account/spaces/${id}`, { id });
  const waiting: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const upload of (space.uploads as any[]).filter(item => item.status === "uploading")) {
    try { await call(context, completeUploadRoute as never, `/api/account/uploads/${upload.id}/complete`, { method: "POST", id: upload.id }); }
    catch (error) {
      if (!(error instanceof Problem) || error.status !== 409) throw error;
      waiting.push(`${upload.name} (${formatBytes(Number(error.data?.offset ?? 0))} of ${formatBytes(upload.size)} stored)`);
    }
  }
  if (waiting.length) return `Not every file is complete yet: ${waiting.join(", ")}. Resume those uploads from the stored byte, then call finish_upload again.`;
  if (args.submit === false) return "Every file is uploaded. Call finish_upload with submit true when the space should be processed.";
  const submitted = await call(context, submitRoute as never, `/api/account/spaces/${id}/submit`, { method: "POST", id,
    body: typeof args.notes === "string" && args.notes.trim() ? { notes: args.notes } : {} });
  return `Submitted for processing. ${siteBrand()} emails the account when the space is ready, usually within a few hours. ${describeSpace(context, submitted.space)}`;
}

async function spaceStatus(args: Record<string, unknown>, context: McpContext) {
  if (typeof args.space_id === "string" && args.space_id) {
    const { space } = await call(context, readSpaceRoute as never, `/api/account/spaces/${args.space_id}`, { id: args.space_id });
    return describeSpace(context, space);
  }
  const { spaces, account } = await call(context, listSpacesRoute as never, "/api/account/spaces");
  if (!spaces.length) return `The account ${account.email} has no spaces yet.`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return [`${spaces.length} space${spaces.length === 1 ? "" : "s"} on ${account.email}.`, ...spaces.map((space: any) => describeSpace(context, space))].join("\n");
}

async function setVisibility(args: Record<string, unknown>, context: McpContext) {
  const id = String(args.space_id ?? "");
  const { space } = await call(context, editSpaceRoute as never, `/api/account/spaces/${id}`, { method: "PATCH", id, body: { public: Boolean(args.public) } });
  return describeSpace(context, space);
}

async function unlinkAccount(_args: Record<string, unknown>, context: McpContext) {
  const user = context.token ? userFromAgentToken(context.token) : undefined;
  if (context.token) deleteAgentToken(context.token);
  if (context.sessionId) saveMcpSecret(context.sessionId, {});
  return user ? `Unlinked from ${user.email}.` : "This agent was not linked.";
}

export const hostedTools: Tool[] = [
  { name: "link_account", run: linkAccount,
    description: "Links this agent to the person's account. Returns a link where the person signs in and approves a short code; call again once they have. Never ask for a password.",
    inputSchema: { type: "object", properties: { link_code: { type: "string", description: "Only for connections without a session, the link_code from the previous call." } } } },
  { name: "list_plans", run: listPlans, description: "The ways to pay for hosting, with prices, and the account's current plan. Show them to the person before the first space.",
    inputSchema: { type: "object", properties: {} } },
  { name: "create_space", run: createSpace,
    description: "Creates a space for one capture. When the account does not pay for hosting yet, it returns a Stripe Checkout link for the plan the person chose (pay as you go when none is given) for them to pay; then call wait_for_payment. Never ask for card details.",
    inputSchema: { type: "object", properties: { title: { type: "string", description: "Title of the space, 1 to 200 characters." },
      plan: { type: "string", description: "Optional plan name or ID from list_plans." } }, required: ["title"] } },
  { name: "wait_for_payment", run: waitForPayment, description: "Waits up to 25 seconds for the person to finish paying in Stripe Checkout. Call it again to keep waiting.",
    inputSchema: { type: "object", properties: { space_id: spaceIdSchema }, required: ["space_id"] } },
  { name: "upload_files", run: uploadFiles,
    description: "Starts resumable uploads for capture files you hold (for example photos or video the person shared with you) and returns where to PUT each file's bytes. For files on the person's own device, give them the space's page to drop the files instead.",
    inputSchema: { type: "object", properties: { space_id: spaceIdSchema, files: { type: "array", items: { type: "object", properties: {
      name: { type: "string" }, size: { type: "integer", description: "Size in bytes." }, type: { type: "string", description: "Optional MIME type." } }, required: ["name", "size"] } } },
    required: ["space_id", "files"] } },
  { name: "finish_upload", run: finishUpload, description: "Checks that every uploaded file is complete and submits the space for processing. The account is emailed when the space is ready.",
    inputSchema: { type: "object", properties: { space_id: spaceIdSchema, notes: { type: "string", description: "Optional notes for processing, such as what the capture is or how the tour should go." },
      submit: { type: "boolean", description: "Defaults to true." } }, required: ["space_id"] } },
  { name: "space_status", run: spaceStatus, description: "Status of one space, or every space on the account with its link when ready.",
    inputSchema: { type: "object", properties: { space_id: spaceIdSchema } } },
  { name: "set_visibility", run: setVisibility, description: "Makes a ready space public (anyone with the link) or private (only the owner). Ask the person first.",
    inputSchema: { type: "object", properties: { space_id: spaceIdSchema, public: { type: "boolean" } }, required: ["space_id", "public"] } },
  { name: "unlink_account", run: unlinkAccount, description: "Unlinks this agent from the account.", inputSchema: { type: "object", properties: {} } }
];

export function hostedInstructions() {
  const brand = siteBrand();
  const local = process.env.SPHR_AGENT_CONNECTOR_URL?.trim();
  return `${brand} hosts 3D captures (laser scans and E57 files, Matterport exports, Gaussian splats, 360 photos and video, meshes, photo sets) as virtual spaces with guided tours that are shared with a link.

This connector runs on the ${brand} server, so it cannot read files on the person's computer. Link the account with link_account (the person approves a code in their browser), show the plans before the first space, create one space per capture and send the person the Stripe Checkout link it returns, then wait_for_payment. Upload files you hold yourself with upload_files and finish_upload. For files on the person's own computer or phone, give them the space's page, where they drop the files and processing starts on its own.${local ? ` If you can run commands on the person's computer, the local connector uploads big files for them (${local}).` : ""} ${brand} emails the person when the space is ready. Never ask for passwords or card details.`;
}

export async function runHostedTool(name: string, args: Record<string, unknown>, context: McpContext) {
  const tool = hostedTools.find(item => item.name === name);
  if (!tool) return { error: `Unknown tool ${name}` } as const;
  try { return { text: await tool.run(args, context) } as const; }
  catch (error) {
    if (error instanceof Problem) return { text: error.message, isError: true } as const;
    console.error(`Hosted MCP tool ${name} failed:`, error instanceof Error ? error.message : error);
    return { text: "Something went wrong on the server. Try again.", isError: true } as const;
  }
}
