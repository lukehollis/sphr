import ErrorSheet from "@/components/site/ErrorSheet";
import { accountsEnabled } from "@/lib/server/accounts";

export default function NotFound() {
  const [href, label] = accountsEnabled() ? ["/account", "Go to your spaces"] : ["/", "Browse all spaces"];
  return <ErrorSheet code="404" title="This space isn’t here." text="The link may be incomplete, or the space may have been removed.">
    <a className="site-button" href={href}>{label}<span aria-hidden="true">→</span></a>
  </ErrorSheet>;
}
