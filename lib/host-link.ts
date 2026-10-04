import { track } from "@/components/Analytics";

/** The operator's site, credited in the viewer. */
export type ViewerHost = { name: string; href: string };

/** The operator's address tagged with where in the viewer it was followed, so visits from it show as their own source. */
export function hostHref(host: ViewerHost, placement: "eyebrow" | "badge") {
  try {
    const url = new URL(host.href);
    url.searchParams.set("utm_source", "viewer");
    url.searchParams.set("utm_medium", "referral");
    url.searchParams.set("utm_campaign", "hosted");
    url.searchParams.set("utm_content", placement);
    return url.toString();
  } catch { return host.href; }
}

export function trackHostClick(label: string, href: string) {
  track("cta_click", { label, href: href.slice(0, 200) });
}

export function trackBuildClick(href: string) {
  track("cta_click", { label: "Build on this space", href: href.slice(0, 200) });
}
