import { formatBytes } from "../bytes";
import type { MailContent } from "./mail";

/*
 * Account and space notices, set like a page of the 1975 NASA Graphics Standards
 * Manual: a white sheet on cream stock, a heavy black rule at the top, Helvetica,
 * hairline rules for structure and NASA Red for the one action on the page.
 * Tables and inline styles, because that is what mail clients render reliably.
 * Every message also has a plain-text body.
 */

const font = "Helvetica, 'Helvetica Neue', Arial, sans-serif";
const color = { stock: "#f2efe6", sheet: "#ffffff", ink: "#111111", body: "#222222", muted: "#555555", label: "#888888", hairline: "#dddddd", red: "#e03c31" };

type Block =
  | { kind: "text"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "details"; rows: Array<[string, string]> }
  | { kind: "image"; src: string; href: string; alt: string };

type Link = { label: string; url: string };

interface Email {
  brand: string;
  origin: string;
  subject: string;
  preheader: string;
  /** Small red line above the heading, usually the space's title. */
  eyebrow?: string;
  heading: string;
  blocks: Block[];
  action?: Link;
  after?: Block[];
  secondary?: Link;
  /** Shows the action's address for readers whose client hides the button. */
  showActionUrl?: boolean;
}

function escape(value: string) {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

const row = (content: string, padding: string) => `<tr><td class="pad" style="padding:${padding};">${content}</td></tr>`;

function blockHtml(block: Block) {
  if (block.kind === "text") {
    return row(`<p style="margin:0;font-family:${font};font-size:16px;line-height:1.55;color:${color.body};">${escape(block.text)}</p>`, "16px 40px 0");
  }
  if (block.kind === "quote") {
    return row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="border-left:3px solid ${color.red};background:${color.stock};padding:14px 16px;font-family:${font};font-size:15px;line-height:1.55;color:${color.ink};white-space:pre-wrap;">${escape(block.text)}</td>
</tr></table>`, "18px 40px 0");
  }
  if (block.kind === "details") {
    const rows = block.rows.map(([label, value], index) => `<tr>
<td style="padding:10px 0;${index ? `border-top:1px solid ${color.hairline};` : ""}font-family:${font};font-size:13px;line-height:1.4;font-weight:700;color:${color.ink};width:40%;">${escape(label)}</td>
<td style="padding:10px 0;${index ? `border-top:1px solid ${color.hairline};` : ""}font-family:${font};font-size:13px;line-height:1.4;color:${color.body};">${escape(value)}</td>
</tr>`).join("");
    return row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${color.ink};border-bottom:1px solid ${color.hairline};">${rows}</table>`, "24px 40px 0");
  }
  return row(`<a href="${escape(block.href)}" style="display:block;text-decoration:none;"><img src="${escape(block.src)}" width="520" alt="${escape(block.alt)}"
style="display:block;width:100%;max-width:520px;height:auto;border:1px solid ${color.hairline};background:${color.stock};font-family:${font};font-size:13px;color:${color.muted};"></a>`, "24px 40px 0");
}

function blockText(block: Block) {
  if (block.kind === "text") return block.text;
  if (block.kind === "quote") return block.text.split("\n").map(line => `> ${line}`).join("\n");
  if (block.kind === "details") return block.rows.map(([label, value]) => `${label}  ${value}`).join("\n");
  return "";
}

function render(email: Email): MailContent {
  const account = `${email.origin}/account`;
  const action = email.action ? row(`<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td bgcolor="${color.red}" style="background:${color.red};">
<a href="${escape(email.action.url)}" style="display:inline-block;padding:15px 24px;font-family:${font};font-size:15px;line-height:1;font-weight:700;color:#ffffff;text-decoration:none;">${escape(email.action.label)}&nbsp;&nbsp;&rarr;</a>
</td></tr></table>`, "28px 40px 0") : "";
  const actionUrl = email.action && email.showActionUrl ? row(`<p style="margin:0;font-family:${font};font-size:12px;line-height:1.5;color:${color.label};">If the button does not work, paste this address into your browser<br>
<a href="${escape(email.action.url)}" style="color:${color.muted};word-break:break-all;">${escape(email.action.url)}</a></p>`, "14px 40px 0") : "";
  const secondary = email.secondary ? row(`<p style="margin:0;font-family:${font};font-size:14px;line-height:1.5;color:${color.muted};">
<a href="${escape(email.secondary.url)}" style="color:${color.ink};text-decoration:underline;">${escape(email.secondary.label)}</a></p>`, "16px 40px 0") : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${escape(email.subject)}</title>
<style>
@media (max-width: 620px) {
  .sheet { width: 100% !important; }
  .pad { padding-left: 24px !important; padding-right: 24px !important; }
  .heading { font-size: 26px !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:${color.stock};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escape(email.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${color.stock};">
<tr><td align="center" style="padding:32px 12px 40px;">
<table role="presentation" class="sheet" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:${color.sheet};border-top:3px solid ${color.ink};">
${row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="font-family:${font};font-size:15px;line-height:1;font-weight:700;color:${color.ink};">
<span style="display:inline-block;width:8px;height:8px;background:${color.red};margin-right:8px;vertical-align:1px;"></span>${escape(email.brand)}</td>
<td align="right" style="font-family:${font};font-size:12px;line-height:1;color:${color.label};"><a href="${escape(account)}" style="color:${color.label};text-decoration:none;">Your spaces</a></td>
</tr></table>`, "20px 40px 0")}
${row(email.eyebrow ? `<div style="border-top:1px solid ${color.ink};padding-top:12px;font-family:${font};font-size:13px;line-height:1.4;font-weight:700;color:${color.red};">${escape(email.eyebrow)}</div>`
    : `<div style="border-top:1px solid ${color.ink};font-size:0;line-height:0;">&nbsp;</div>`, "32px 40px 0")}
${row(`<h1 class="heading" style="margin:0;font-family:${font};font-size:30px;line-height:1.1;font-weight:700;letter-spacing:-0.01em;color:${color.ink};">${escape(email.heading)}</h1>`, "14px 40px 0")}
${email.blocks.map(blockHtml).join("\n")}
${action}
${actionUrl}
${(email.after ?? []).map(blockHtml).join("\n")}
${secondary}
${row(`<div style="border-top:1px solid ${color.hairline};padding-top:14px;font-family:${font};font-size:12px;line-height:1.5;color:${color.label};">
${escape(email.brand)} sends these emails about your account and your spaces.<br>
<a href="${escape(account)}" style="color:${color.muted};">${escape(account.replace(/^https?:\/\//, ""))}</a></div>`, "40px 40px 32px")}
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    email.heading,
    ...email.blocks.map(blockText),
    ...(email.action ? [`${email.action.label}\n${email.action.url}`] : []),
    ...(email.after ?? []).map(blockText),
    ...(email.secondary ? [`${email.secondary.label}\n${email.secondary.url}`] : []),
    `${email.brand} sends these emails about your account and your spaces.\n${account}`
  ].filter(Boolean).join("\n\n");

  return { subject: email.subject, text, html };
}

/** A line that tells the reader how to reach a person, when the deployment has a contact address (replies go there too). */
const help = (support: string | undefined, text = "Questions?"): Block[] => support ? [{ kind: "text", text: `${text} Reply to this email or write to ${support}.` }] : [];

export function verificationEmail(brand: string, origin: string, link: string) {
  return render({
    brand, origin, subject: "Confirm your email address", preheader: "Confirm your address to start building guided tours and scavenger hunts and hosting your spaces.",
    heading: "Confirm your email address",
    blocks: [{ kind: "text", text: `Confirm the email address for your account at ${origin}. Then you can build guided tours and scavenger hunts, and upload captures to host as your own spaces.` }],
    action: { label: "Confirm email address", url: link }, showActionUrl: true,
    after: [{ kind: "text", text: "The link works for 7 days. If you did not create an account, you can ignore this email." }]
  });
}

export function passwordResetEmail(brand: string, origin: string, link: string) {
  return render({
    brand, origin, subject: "Reset your password", preheader: "Choose a new password for your account.",
    heading: "Choose a new password",
    blocks: [{ kind: "text", text: `Choose a new password for your account at ${origin}.` }],
    action: { label: "Choose a new password", url: link }, showActionUrl: true,
    after: [{ kind: "text", text: "The link works for one hour. If you did not ask for this, you can ignore this email and your password stays the same." }]
  });
}

export function providerLinkedEmail(brand: string, origin: string, provider: string) {
  return render({
    brand, origin, subject: `${provider} sign-in added to your account`, preheader: `You can now sign in with ${provider}.`,
    heading: `${provider} sign-in added`,
    blocks: [
      { kind: "text", text: `You signed in to ${origin} with ${provider}, which confirmed that this address is yours. Your account's password was removed and your other sessions were signed out.` },
      { kind: "text", text: "To use a password again, choose Forgot password on the sign-in page." }
    ],
    action: { label: "Open your spaces", url: `${origin}/account` }
  });
}

type SpaceRef = { id: string; title: string };
const spacePage = (origin: string, space: SpaceRef) => `${origin}/account/spaces/${space.id}`;

/** Sent when uploaded files are submitted, which starts processing. */
export function filesReceivedEmail(brand: string, origin: string, space: SpaceRef, files: { count: number; bytes: number }) {
  return render({
    brand, origin, subject: `Processing started for ${space.title}`, preheader: "We have your files and an agent is building the space.",
    eyebrow: space.title, heading: "We have your files",
    blocks: [
      { kind: "text", text: "An agent has started turning them into a space. We will email you again as soon as it is ready to open." },
      { kind: "details", rows: [["Files", String(files.count)], ["Total size", formatBytes(files.bytes)]] }
    ],
    action: { label: "Follow the progress", url: spacePage(origin, space) }
  });
}

/** `scene.public` is the space's visibility now: a space processed again keeps the visibility its owner chose. */
export function spaceReadyEmail(brand: string, origin: string, space: SpaceRef, scene?: { path: string; thumbnail?: string; public?: boolean }) {
  const viewer = scene ? `${origin}${scene.path}` : spacePage(origin, space);
  // Installations that publish locally list the thumbnail by path; mail needs the full address.
  const thumbnail = scene?.thumbnail?.startsWith("/") ? `${origin}${scene.thumbnail}` : scene?.thumbnail;
  const shared = scene?.public === true;
  return render({
    brand, origin, subject: `${space.title} is ready`,
    preheader: shared ? "Your space is hosted, and anyone with its link can open it." : "Your space is hosted. Only you can open it until you make it public.",
    eyebrow: space.title, heading: "Your space is ready",
    blocks: [
      ...(thumbnail ? [{ kind: "image" as const, src: thumbnail, href: viewer, alt: space.title }] : []),
      { kind: "text", text: shared ? "It is public, so anyone with the link can open it. Change who can see it on the space page."
        : "It is private for now, so only you can open it. Make it public on the space page whenever you want to share the link." }
    ],
    action: { label: "Open the space", url: viewer },
    secondary: { label: "Sharing and settings", url: spacePage(origin, space) }
  });
}

export function spaceFailedEmail(brand: string, origin: string, space: SpaceRef, message: string, support?: string) {
  return render({
    brand, origin, subject: `${space.title} needs attention`, preheader: "Processing stopped before the space was finished.",
    eyebrow: space.title, heading: "We could not finish this space",
    blocks: [
      { kind: "text", text: "Processing stopped with this note." },
      { kind: "quote", text: message },
      { kind: "text", text: "Add or replace files on the space page and processing starts again." },
      ...help(support, "Stuck, or not sure what to change?")
    ],
    action: { label: "Open the space page", url: spacePage(origin, space) }
  });
}

// ---- Billing ----
// Sent when Stripe's state for a subscription changes; each change is announced once (see billing.ts).

const day = (seconds: number) => new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(new Date(seconds * 1000));
const planRows = (plan: string | undefined): Block[] => plan ? [{ kind: "details", rows: [["Plan", plan]] }] : [];

/** A renewal payment failed; Stripe retries it while the spaces stay online. */
export function paymentFailedEmail(brand: string, origin: string, support: string | undefined, plan?: string) {
  return render({
    brand, origin, subject: "Your payment did not go through", preheader: "Your spaces are still online. Update your payment method to keep them there.",
    heading: "Your payment did not go through",
    blocks: [
      { kind: "text", text: "We could not collect the latest payment for hosting your spaces. Your spaces are still online, and the payment will be tried again over the next few days." },
      { kind: "text", text: "If it keeps failing, hosting stops and your spaces, with the tours and scavenger hunts on them, go offline until a payment goes through. To avoid that, update your payment method on your account page." },
      ...planRows(plan)
    ],
    action: { label: "Update payment method", url: `${origin}/account` },
    after: help(support)
  });
}

/**
 * Why hosting stopped (the plan ended as cancelled, a payment was never collected, or it ended
 * otherwise) and what brings it back: paying the subscription that still exists, or restarting billing.
 */
export type HostingStop = { why: "cancelled" | "unpaid" | "ended"; fix: "payment" | "restart" };

/** A subscription stopped covering hosting, so the customer's spaces went offline. */
export function hostingStoppedEmail(brand: string, origin: string, support: string | undefined, { why, fix }: HostingStop, plan?: string) {
  return render({
    brand, origin, subject: "Your spaces are offline", preheader: "Hosting has stopped. Nothing has been deleted, and your spaces come back once billing does.",
    heading: "Your spaces are offline",
    blocks: [
      { kind: "text", text: why === "cancelled" ? "Your plan was cancelled and has now ended, so hosting has stopped."
        : why === "unpaid" ? "We could not collect the payment for your plan, so hosting has stopped."
        : "Your plan has ended, so hosting has stopped." },
      { kind: "text", text: "Your spaces, and the tours and scavenger hunts on them, no longer open for anyone, including people with a public link. Nothing has been deleted." },
      { kind: "text", text: fix === "payment" ? "Update your payment method on your account page and they come back online as soon as the payment goes through."
        : "Restart billing on your account page and they come back online as soon as you have paid." },
      ...planRows(plan)
    ],
    action: { label: fix === "payment" ? "Update payment method" : "Restart billing", url: `${origin}/account` },
    after: help(support)
  });
}

/** A cancellation was scheduled for the end of the paid period. `ends` is in seconds, as Stripe gives it. */
export function cancellationScheduledEmail(brand: string, origin: string, support: string | undefined, ends: number | null, plan?: string) {
  const until = ends ? `until ${day(ends)}, the end of the period already paid for` : "until the end of the period already paid for";
  return render({
    brand, origin, subject: "Your plan is set to end", preheader: `Your spaces stay online ${until}.`,
    heading: "Your plan is set to end",
    blocks: [
      { kind: "text", text: `Your plan has been cancelled. Nothing changes yet: your spaces stay online ${until}.` },
      { kind: "text", text: "After that, your spaces and the tours and scavenger hunts on them go offline until billing restarts. Nothing is deleted." },
      { kind: "text", text: "Changed your mind? Renew the plan under Billing and invoices on your account page before it ends, and nothing changes." },
      ...planRows(plan)
    ],
    action: { label: "Open your account", url: `${origin}/account` },
    after: help(support)
  });
}
