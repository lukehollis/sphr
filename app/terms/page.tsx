import { notFound } from "next/navigation";
import PolicyPage from "@/components/site/PolicyPage";
import { accountsEnabled } from "@/lib/server/accounts";
import { siteBrand } from "@/lib/server/brand";
import { operator } from "@/lib/server/legal";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terms" };

export default function TermsPage() {
  if (!accountsEnabled()) notFound();
  const { name, contact, updated } = operator();
  const reach = contact ? <a href={`mailto:${contact}`}>{contact}</a> : "the contact address on this site";
  return <PolicyPage brand={siteBrand()} code="T" title="Terms" lede={<>Updated {updated}. These terms cover the space hosting service run by {name}.</>} sections={[
    { id: "service", title: "The service", body: <p>You upload captures of places or objects; we process them into interactive spaces and host them for you to view and share. Processing is automated and can fail or need a different upload; we will tell you what to change.</p> },
    { id: "account", title: "Your account", body: <p>Keep your sign-in secure and your email address current. You are responsible for activity under your account.</p> },
    { id: "content", title: "Your content", body: <p>You keep all rights to your uploads and spaces. You give us permission to store, process, display and deliver them as needed to run the service for you. Only upload content you have the right to share, and nothing unlawful, infringing or that invades someone&apos;s privacy. We may remove content that breaks these terms.</p> },
    { id: "payment", title: "Payment", body: <p>Hosting is billed through Stripe, either for each space (pay as you go) or as a plan that covers a set number of spaces, at the prices shown when you choose. On pay as you go, adding or deleting a space changes your next invoice, prorated for the period. Changing plans applies at once and your next invoice is prorated too. You can cancel any time in the billing portal, and your spaces stay online until the end of the paid period. If payment fails and is not resolved, hosting pauses until it is.</p> },
    { id: "availability", title: "Availability", body: <p>We work to keep the service running and your spaces safe, but the service is provided as is, without warranties. Keep your original capture files. To the extent the law allows, our liability is limited to the amount you paid us in the three months before a claim.</p> },
    { id: "changes", title: "Changes and contact", body: <p>We may update these terms and will note the date above; significant changes are emailed to account holders. Questions: {reach}.</p> }
  ]} />;
}
