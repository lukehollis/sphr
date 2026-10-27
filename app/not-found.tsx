import type { Metadata } from "next";
import { connection } from "next/server";
import ErrorSheet from "@/components/site/ErrorSheet";
import { accountsEnabled } from "@/lib/server/accounts";

export const metadata: Metadata = { title: "Page not found" };

export default async function NotFound() {
  // Served from the deployment's settings (its name in the title, whether it has accounts), not the build's.
  await connection();
  const [href, label] = accountsEnabled() ? ["/account", "Go to your spaces"] : ["/", "Browse all spaces"];
  return <ErrorSheet code="404" title="This space isn’t here." text="The link may be incomplete, or the space may have been removed.">
    <a className="site-button" href={href}>{label}<span aria-hidden="true">→</span></a>
  </ErrorSheet>;
}
