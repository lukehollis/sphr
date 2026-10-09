import nodemailer, { type Transporter } from "nodemailer";
import { contactEmail } from "./brand";

let transport: { url: string; mailer: Transporter } | undefined;

export type MailContent = { subject: string; text: string; html?: string };

const env = (name: string) => process.env[name]?.trim() || undefined;

/** Password accounts need email for verification and resets. Development prints the links instead. */
export function mailConfigured() {
  return Boolean(env("SPHR_SMTP_URL") && env("SPHR_MAIL_FROM")) || process.env.NODE_ENV !== "production";
}

/**
 * Where replies to account emails go: `SPHR_MAIL_REPLY_TO`, or else the contact address. Every
 * message carries it, so a customer answering an email reaches a person even when the sender
 * address takes no mail.
 */
export function mailReplyTo() {
  return env("SPHR_MAIL_REPLY_TO") ?? contactEmail();
}

/** Sends a message with a plain-text body and, when given, an HTML alternative. */
export async function sendMail(to: string, { subject, text, html }: MailContent) {
  const url = env("SPHR_SMTP_URL"), from = env("SPHR_MAIL_FROM"), replyTo = mailReplyTo();
  if (!url || !from) {
    if (process.env.NODE_ENV === "production") throw new Error("Email delivery is not configured.");
    console.info(`[mail] To: ${to}${replyTo ? `\n[mail] Reply-To: ${replyTo}` : ""}\n[mail] Subject: ${subject}\n${text}`);
    return;
  }
  // A mail server that stops answering fails the send in seconds instead of holding the request that sent it.
  if (transport?.url !== url) transport = { url, mailer: nodemailer.createTransport({ url, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 }) };
  await transport.mailer.sendMail({ from, to, subject, text, ...(replyTo ? { replyTo } : {}), ...(html ? { html } : {}) });
}

/**
 * Sends a notice that must never fail the work that prompted it (a webhook, a worker's report,
 * a page). A failure is logged with the subject and the account it was for, and returns false.
 */
export async function sendNotice(to: string, content: MailContent, account: string) {
  try {
    await sendMail(to, content);
    return true;
  } catch (error) {
    console.error(`Unable to send "${content.subject}" to account ${account}:`, error instanceof Error ? error.message : error);
    return false;
  }
}
