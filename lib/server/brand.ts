import { readPrice } from "./billing";
import { formatPrice } from "../price";

/** Site name for headers and page titles. Deployments set their own; the open-source default is SPHR. */
export function siteBrand() {
  return process.env.SPHR_OPERATOR_NAME?.trim() || "SPHR";
}

/** The hosting price for marketing copy, without letting a slow billing API delay the page. */
export async function priceLabel() {
  const price = await Promise.race([readPrice(), new Promise<undefined>(resolve => setTimeout(resolve, 1500))]);
  return price ? formatPrice(price) : null;
}
