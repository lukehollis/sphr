import { notFound } from "next/navigation";
import PolicyPage from "@/components/site/PolicyPage";
import { accountsEnabled } from "@/lib/server/accounts";
import { siteBrand } from "@/lib/server/brand";
import { operator } from "@/lib/server/legal";

export const dynamic = "force-dynamic";
export const metadata = { title: "Privacy" };

export default function PrivacyPage() {
  if (!accountsEnabled()) notFound();
  const { name, contact, updated } = operator();
  const reach = contact ? <a href={`mailto:${contact}`}>{contact}</a> : "the contact address on this site";
  return <PolicyPage brand={siteBrand()} code="P" title="Privacy" lede={<>Updated {updated}. This hosting service is run by {name}.</>} sections={[
    { id: "collect", title: "What we collect", body: <ul>
      <li>Your account: email address, name, and the identifier Google, Apple or LinkedIn gives us when you sign in with them. Passwords are stored only as salted hashes.</li>
      <li>Billing: Stripe processes payments. We keep your Stripe customer and subscription identifiers and status; we never see or store card numbers.</li>
      <li>Your uploads and the spaces built from them, with their titles, notes and settings.</li>
      <li>Technical records needed to run the service, such as server logs and, when enabled, usage analytics. Usage analytics keep a random visitor ID in a cookie and record, on our own server, which pages and steps a visit reaches and which site linked to it. Google Analytics may also be used.</li>
    </ul> },
    { id: "use", title: "How we use it", body: <p>To host your spaces, process your uploads, bill for hosting, keep the service secure, and email you about your account and spaces. Uploads are processed by automated software agents that use a third-party AI model service (Anthropic) to inspect files and build your space. We do not sell personal information or use your uploads to advertise.</p> },
    { id: "sharing", title: "Who else sees it", body: <p>Service providers that run parts of the service for us: Google Cloud (storage and hosting), Stripe (payments), Anthropic (AI processing of uploads) and our email provider. A space you make public can be opened by anyone with its link; private spaces are shown only to you and to us when we help with your account.</p> },
    { id: "retention", title: "How long we keep it", body: <p>Raw uploads are deleted within 90 days of upload. A deleted space stops being served immediately and its files are removed from our storage. To delete your account and its data, contact us at {reach}.</p> },
    { id: "contact", title: "Contact", body: <p>Questions or requests about your data: {reach}.</p> }
  ]} />;
}
