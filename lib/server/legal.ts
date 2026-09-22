/** Operator details for the policy pages, from the deployment's environment. */
export function operator() {
  return {
    name: process.env.SPHR_OPERATOR_NAME?.trim() || "the operator of this site",
    contact: process.env.SPHR_CONTACT_EMAIL?.trim() || null,
    updated: process.env.SPHR_POLICIES_UPDATED?.trim() || "2026-09-22"
  };
}
