import nodemailer, { type Transporter } from "nodemailer";

let transport: Transporter | undefined;

/** Password accounts need email for verification and resets. Development prints the links instead. */
export function mailConfigured() {
  return Boolean(process.env.SPHR_SMTP_URL && process.env.SPHR_MAIL_FROM) || process.env.NODE_ENV !== "production";
}

export async function sendMail(to: string, subject: string, text: string) {
  if (!process.env.SPHR_SMTP_URL || !process.env.SPHR_MAIL_FROM) {
    if (process.env.NODE_ENV === "production") throw new Error("Email delivery is not configured.");
    console.info(`[mail] To: ${to}\n[mail] Subject: ${subject}\n${text}`);
    return;
  }
  transport ??= nodemailer.createTransport(process.env.SPHR_SMTP_URL);
  await transport.sendMail({ from: process.env.SPHR_MAIL_FROM, to, subject, text });
}
