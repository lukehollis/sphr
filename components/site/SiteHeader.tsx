"use client";

import { useState } from "react";
import { Wordmark, type NavItem } from "./Chrome";

/** Top of every page outside the viewer: the opening rule, the site name, navigation and sign-out. */
export default function SiteHeader({ brand, home = "/account", nav = [], account, signOut }:
  { brand: string; home?: string; nav?: NavItem[]; account?: string; signOut?: "account" | "admin" }) {
  const [error, setError] = useState("");
  async function leave() {
    try {
      const response = await fetch(signOut === "admin" ? "/api/admin/logout" : "/api/account/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!response.ok) throw new Error();
      window.location.assign(signOut === "admin" ? "/admin/login" : "/account/login");
    } catch { setError("Sign-out failed. Try again."); }
  }
  return <header className="site-header">
    <Wordmark brand={brand} href={home} />
    <nav className="site-nav" aria-label="Main">
      {nav.map(item => <a key={item.href} href={item.href} aria-current={item.current ? "page" : undefined}>{item.label}</a>)}
      {account && <span className="site-nav-account" title={account}>{account}</span>}
      {signOut && <button type="button" onClick={leave}>Sign out</button>}
      {error && <span role="alert" className="site-nav-error">{error}</span>}
    </nav>
  </header>;
}
