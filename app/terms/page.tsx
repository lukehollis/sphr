import { notFound } from "next/navigation";
import { accountsEnabled } from "@/lib/server/accounts";
import { readPrice } from "@/lib/server/billing";
import { operator } from "@/lib/server/legal";
import { formatPrice } from "@/lib/price";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terms" };

export default async function TermsPage() {
  if (!accountsEnabled()) notFound();
  const { name, contact, updated } = operator();
  const price = await readPrice();
  const reach = contact ? <a href={`mailto:${contact}`}>{contact}</a> : "the contact address on this site";
  return <main className="space-library policy-page"><article className="library-shell policy">
    <h1>Terms</h1>
    <p className="admin-help">Updated {updated}. These terms cover the space hosting service run by {name}.</p>
    <h2>The service</h2>
    <p>You upload captures of places or objects; we process them into interactive spaces and host them for you to view and share. Processing is automated and can fail or need a different upload; we will tell you what to change.</p>
    <h2>Your account</h2>
    <p>Keep your sign-in secure and your email address current. You are responsible for activity under your account.</p>
    <h2>Your content</h2>
    <p>You keep all rights to your uploads and spaces. You give us permission to store, process, display and deliver them as needed to run the service for you. Only upload content you have the right to share, and nothing unlawful, infringing or that invades someone&apos;s privacy. We may remove content that breaks these terms.</p>
    <h2>Payment</h2>
    <p>Hosting is billed per space{price ? `, ${formatPrice(price)}` : ""}, through Stripe. Adding or deleting a space changes your next invoice, prorated for the period. You can cancel any time in the billing portal; your spaces stay online until the end of the paid period. If payment fails and is not resolved, hosting pauses until it is.</p>
    <h2>Availability</h2>
    <p>We work to keep the service running and your spaces safe, but the service is provided as is, without warranties. Keep your original capture files. To the extent the law allows, our liability is limited to the amount you paid us in the three months before a claim.</p>
    <h2>Changes and contact</h2>
    <p>We may update these terms and will note the date above; significant changes are emailed to account holders. Questions: {reach}.</p>
  </article></main>;
}
