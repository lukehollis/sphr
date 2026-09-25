/** Site name for headers and page titles. Deployments set their own; the open-source default is SPHR. */
export function siteBrand() {
  return process.env.SPHR_OPERATOR_NAME?.trim() || "SPHR";
}
