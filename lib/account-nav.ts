import type { AccountView } from "@/lib/server/customer-spaces";

/** Links at the top of the account pages: spaces, team, profile, and the plan once there is one. */
export function accountNav(account: Pick<AccountView, "billing" | "subscription"> & Partial<Pick<AccountView, "team">>,
  current: "spaces" | "plan" | "space" | "profile" | "team") {
  const showPlan = (account.billing && (account.subscription || current === "plan") && account.team?.role !== "member" && !account.team?.invoiced)
    || current === "plan";
  return [
    { href: "/account", label: "Your spaces", current: current === "spaces" },
    { href: "/account/team", label: "Team", current: current === "team" },
    { href: "/account/profile", label: "Profile", current: current === "profile" },
    ...(showPlan ? [{ href: "/account/plan", label: "Plan", current: current === "plan" }] : []),
  ];
}
