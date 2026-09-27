/** Site name for headers and page titles. Deployments set their own; the open-source default is SPHR. */
export function siteBrand() {
  return process.env.SPHR_OPERATOR_NAME?.trim() || "SPHR";
}

/** Where the source code this deployment runs is published. The plan choice links to it when set. */
export function sourceUrl() {
  const value = process.env.SPHR_SOURCE_URL?.trim();
  return value && /^https:\/\/[^\s"<>]+$/.test(value) ? value : undefined;
}
