import nodemailer, { type Transporter } from "nodemailer";

let transport: Transporter | undefined;

export type MailContent = { subject: string; text: string; html?: string };

/** Password accounts need email for verification and resets. Development prints the links instead. */
export function mailConfigured() {
  return Boolean(process.env.SPHR_SMTP_URL && process.env.SPHR_MAIL_FROM) || process.env.NODE_ENV !== "production";
}

/** Sends a message with a plain-text body and, when given, an HTML alternative. */
export async function sendMail(to: string, { subject, text, html }: MailContent) {
  if (!process.env.SPHR_SMTP_URL || !process.env.SPHR_MAIL_FROM) {
    if (process.env.NODE_ENV === "production") throw new Error("Email delivery is not configured.");
    console.info(`[mail] To: ${to}\n[mail] Subject: ${subject}\n${text}`);
    return;
  }
  transport ??= nodemailer.createTransport(process.env.SPHR_SMTP_URL);
  await transport.sendMail({ from: process.env.SPHR_MAIL_FROM, to, subject, text, ...(html ? { html } : {}) });
}
