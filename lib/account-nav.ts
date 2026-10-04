import type { AccountView } from "@/lib/server/customer-spaces";

/** Links at the top of the account pages: spaces, profile, and the plan once there is one. */
export function accountNav(account: Pick<AccountView, "billing" | "subscription">, current: "spaces" | "plan" | "space" | "profile") {
  return [{ href: "/account", label: "Your spaces", current: current === "spaces" },
    { href: "/account/profile", label: "Profile", current: current === "profile" },
    ...(account.billing && (account.subscription || current === "plan") ? [{ href: "/account/plan", label: "Plan", current: current === "plan" }] : [])];
}
