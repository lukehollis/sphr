/** Site name for headers and page titles. Deployments set their own; the open-source default is SPHR. */
export function siteBrand() {
  return process.env.SPHR_OPERATOR_NAME?.trim() || "SPHR";
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

/** Where the source code this deployment runs is published. The plan choice links to it when set. */
export function sourceUrl() {
  const value = process.env.SPHR_SOURCE_URL?.trim();
  return value && /^https:\/\/[^\s"<>]+$/.test(value) ? value : undefined;
}
