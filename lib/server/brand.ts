/** Site name for headers and page titles. Deployments set their own; the open-source default is SPHR. */
export function siteBrand() {
  return process.env.SPHR_OPERATOR_NAME?.trim() || "SPHR";
}

/** The site's public origin, for links made outside a request (emails from webhooks and sweeps). */
export function siteOrigin() {
  return new URL(process.env.SPHR_PUBLIC_URL || "http://localhost:3002").origin;
}

/** The operator's own website. When set, the viewer names the site above each space's title and links there. */
export function siteHome() {
  const value = process.env.SPHR_OPERATOR_URL?.trim();
  return value && /^https:\/\/[^\s"<>]+$/.test(value) ? value : undefined;
}

/** The site name and website the viewer credits, or nothing when the deployment has no website of its own. */
export function viewerHost() {
  const href = siteHome();
  return href ? { name: siteBrand(), href } : undefined;
}

const emailAddress = (value: string | undefined) => value && /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(value) ? value : undefined;

/**
 * Where customers write for help. The policies, account emails and error messages name it,
 * and replies to account emails go there unless `SPHR_MAIL_REPLY_TO` says otherwise.
 */
export function contactEmail() {
  return emailAddress(process.env.SPHR_CONTACT_EMAIL?.trim());
}

/** Where larger customers write to arrange an enterprise plan, the contact address unless another is set. The plan choice offers it when there is one. */
export function salesEmail() {
  return emailAddress(process.env.SPHR_SALES_EMAIL?.trim()) ?? contactEmail();
}

/** Where the source code this deployment runs is published. The plan choice links to it when set. */
export function sourceUrl() {
  const value = process.env.SPHR_SOURCE_URL?.trim();
  return value && /^https:\/\/[^\s"<>]+$/.test(value) ? value : undefined;
}
