import { notFound } from "next/navigation";
import { accountsEnabled } from "@/lib/server/accounts";
import { operator } from "@/lib/server/legal";

export const dynamic = "force-dynamic";
export const metadata = { title: "Privacy" };

export default function PrivacyPage() {
  if (!accountsEnabled()) notFound();
  const { name, contact, updated } = operator();
  const reach = contact ? <a href={`mailto:${contact}`}>{contact}</a> : "the contact address on this site";
  return <main className="space-library policy-page"><article className="library-shell policy">
    <h1>Privacy</h1>
    <p className="admin-help">Updated {updated}. This hosting service is run by {name}.</p>
    <h2>What we collect</h2>
    <ul>
      <li>Your account: email address, name, and the identifier Google, Apple or LinkedIn gives us when you sign in with them. Passwords are stored only as salted hashes.</li>
      <li>Billing: Stripe processes payments. We keep your Stripe customer and subscription identifiers and status; we never see or store card numbers.</li>
      <li>Your uploads and the spaces built from them, with their titles, notes and settings.</li>
      <li>Technical records needed to run the service, such as server logs and, if enabled, aggregate analytics.</li>
    </ul>
    <h2>How we use it</h2>
    <p>To host your spaces, process your uploads, bill for hosting, keep the service secure, and email you about your account and spaces. Uploads are processed by automated software agents that use a third-party AI model service (Anthropic) to inspect files and build your space. We do not sell personal information or use your uploads to advertise.</p>
    <h2>Who else sees it</h2>
    <p>Service providers that run parts of the service for us: Google Cloud (storage and hosting), Stripe (payments), Anthropic (AI processing of uploads) and our email provider. A space you make public can be opened by anyone with its link; private spaces are shown only to you and to us when we help with your account.</p>
    <h2>How long we keep it</h2>
    <p>Raw uploads are deleted within 90 days of upload. A deleted space stops being served immediately and its files are removed from our storage. To delete your account and its data, contact us at {reach}.</p>
    <h2>Contact</h2>
    <p>Questions or requests about your data: {reach}.</p>
  </article></main>;
}
