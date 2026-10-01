import SiteHeader from "./site/SiteHeader";
import LocalTime from "./LocalTime";
import { SectionHeader, SiteFooter } from "./site/Chrome";
import type { AnalyticsReport as Report } from "@/lib/server/analytics-report";

const ranges = [[7, "7 days"], [30, "30 days"], [90, "90 days"], [365, "1 year"]] as const;
const names: Record<string, string> = {
  page_view: "Viewed", cta_click: "Clicked", section_view: "Scrolled to", sign_up: "Created an account", login: "Signed in", login_failed: "Sign in failed",
  logout: "Signed out", verify_sent: "Sent the confirmation email", email_verified: "Confirmed their email", password_reset: "Asked to reset the password",
  upload_opened: "Opened the upload sheet", files_chosen: "Chose files", files_rejected: "Chose files that cannot be used", space_created: "Created a space",
  checkout_started: "Payment page prepared", checkout_failed: "Payment could not start", plan_chosen: "Chose a plan", checkout_opened: "Opened payment",
  subscription_started: "Paid", subscription_ended: "Billing ended", plan_full: "Plan was full", upload_error: "Upload problem",
  upload_closed: "Closed the upload sheet", upload_cancelled: "Cancelled the space", space_submitted: "Uploaded files", space_ready: "Space went live",
  space_failed: "Space needs attention", space_deleted: "Deleted a space", agent_linked: "Linked an agent"
};
const percent = (part: number, whole: number) => whole ? `${Math.round((part / whole) * 100)}%` : "";

function Tally({ title, rows, unit = "People" }: { title: string; rows: { label: string; total: number }[]; unit?: string }) {
  return <section className="analytics-tally">
    <h3>{title}</h3>
    {rows.length ? <table className="site-table"><thead><tr><th scope="col">{title}</th><th scope="col" className="site-number">{unit}</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.label}><td className="analytics-wrap">{row.label}</td><td className="site-number">{row.total}</td></tr>)}</tbody></table>
      : <p className="site-hint">Nothing yet.</p>}
  </section>;
}

export default function AnalyticsReport({ report, brand, enabled }: { report: Report; brand: string; enabled: boolean }) {
  const top = report.funnel[0]?.total ?? 0;
  return <div className="site"><div className="site-frame">
    <SiteHeader brand={brand} home="/" signOut="admin" nav={[{ href: "/", label: "Collection" }, { href: "/admin", label: "Manage" },
      { href: "/admin/analytics", label: "Analytics", current: true }]} />
    <main className="site-main">
      <div className="site-title">
        <div><h1>Analytics</h1></div>
        <p>Who visits, where they came from, and where they stop. Your own visits are left out.</p>
      </div>
      {!enabled && <p className="site-note">Visits are not being recorded. Build with NEXT_PUBLIC_SPHR_ANALYTICS=1 to record them. The accounts below come from the account records.</p>}
      <nav className="analytics-range" aria-label="Time range">
        {ranges.map(([days, label]) => <a key={days} href={`/admin/analytics?days=${days}`} aria-current={report.days === days ? "page" : undefined}>{label}</a>)}
      </nav>
      <dl className="site-stats">
        <div><dt>People</dt><dd>{report.totals.people}</dd></div>
        <div><dt>Page views</dt><dd>{report.totals.views}</dd></div>
        <div><dt>New accounts</dt><dd>{report.totals.signups}</dd></div>
        <div><dt>Paid</dt><dd>{report.totals.paid}</dd></div>
      </dl>

      <section className="site-block" aria-labelledby="analytics-funnel">
        <SectionHeader title={<span id="analytics-funnel">From a first visit to a live space</span>} />
        <div className="analytics-scroll"><table className="site-table analytics-funnel">
          <thead><tr><th scope="col">Step</th><th scope="col" className="site-number">People</th><th scope="col">Share of visitors</th>
            <th scope="col" className="site-number">Kept from the step before</th><th scope="col" className="site-number">Stopped here</th></tr></thead>
          <tbody>{report.funnel.map((step, index) => {
            const before = index ? report.funnel[index - 1].total : step.total;
            return <tr key={step.key}>
              <th scope="row">{step.label}</th>
              <td className="site-number">{step.total}</td>
              <td><span className="analytics-bar"><span style={{ width: top ? `${Math.max(step.total ? 1 : 0, (step.total / top) * 100)}%` : 0 }} /></span></td>
              <td className="site-number">{index ? percent(step.total, before) : ""}</td>
              <td className="site-number">{index && before > step.total ? before - step.total : ""}</td>
            </tr>;
          })}</tbody>
        </table></div>
        <p className="site-hint">Each person counts once per step. Steps can be skipped, for example by an agent that adds the space, so a later step can be larger.</p>
      </section>

      <section className="site-block" aria-labelledby="analytics-sources">
        <SectionHeader title={<span id="analytics-sources">Where people came from</span>} />
        {report.sources.length ? <div className="analytics-scroll"><table className="site-table">
          <thead><tr><th scope="col">First came from</th><th scope="col">Kind</th><th scope="col" className="site-number">People</th>
            <th scope="col" className="site-number">Accounts</th><th scope="col" className="site-number">Spaces</th><th scope="col" className="site-number">Paid</th></tr></thead>
          <tbody>{report.sources.map(row => <tr key={row.source}>
            <th scope="row">{row.source}</th><td>{row.medium}</td><td className="site-number">{row.people}</td>
            <td className="site-number">{row.signups}</td><td className="site-number">{row.spaces}</td><td className="site-number">{row.paid}</td>
          </tr>)}</tbody>
        </table></div> : <p className="site-hint">Nothing yet.</p>}
      </section>

      <section className="site-block" aria-labelledby="analytics-detail">
        <SectionHeader title={<span id="analytics-detail">Pages, clicks and problems</span>} />
        <div className="analytics-grid">
          <Tally title="Linking pages" rows={report.referrers} />
          <Tally title="First page seen" rows={report.landings} />
          <Tally title="Most viewed pages" rows={report.pages} />
          <Tally title="Homepage clicks" rows={report.clicks} />
          <Tally title="Homepage sections reached" rows={report.sections} />
          <Tally title="Where the upload sheet was left" rows={report.closes} unit="Times" />
          <Tally title="Problems people hit" rows={report.problems} unit="Times" />
          <Tally title="Countries" rows={report.countries} />
          <Tally title="Devices" rows={report.devices} />
        </div>
      </section>

      <section className="site-block" aria-labelledby="analytics-accounts">
        <SectionHeader title={<span id="analytics-accounts">Where each account is now</span>} />
        {report.accounts.length ? <div className="analytics-scroll"><table className="site-table">
          <thead><tr><th scope="col">Account</th><th scope="col">Joined</th><th scope="col">Signs in with</th><th scope="col">First came from</th>
            <th scope="col">Where they are</th><th scope="col">Last seen</th></tr></thead>
          <tbody>{report.accounts.map(row => <tr key={row.email}>
            <th scope="row" className="analytics-wrap">{row.email}</th><td><LocalTime value={row.created} /></td><td>{row.method}</td><td>{row.source}</td>
            <td>{row.stage}</td><td>{row.lastSeen ? <LocalTime value={row.lastSeen} /> : ""}</td>
          </tr>)}</tbody>
        </table></div> : <p className="site-hint">No accounts yet.</p>}
      </section>

      <section className="site-block" aria-labelledby="analytics-people">
        <SectionHeader title={<span id="analytics-people">What recent people did</span>} />
        {report.journeys.length ? report.journeys.map(journey => <details className="analytics-journey" key={journey.person}>
          <summary>
            <strong>{journey.label}</strong>
            <span>{journey.source}</span>
            <span>Furthest step {journey.furthest.toLowerCase()}</span>
            <span>{[journey.country, journey.device].filter(Boolean).join(", ")}</span>
            <span><LocalTime value={journey.steps.at(-1)!.at} /></span>
          </summary>
          <ol className="analytics-steps">{journey.steps.map((step, index) => <li key={index}>
            <span><LocalTime value={step.at} /></span><span>{names[step.name] ?? step.name.replaceAll("_", " ")}</span><span className="analytics-wrap">{step.detail}</span>
          </li>)}</ol>
        </details>) : <p className="site-hint">Nothing yet.</p>}
      </section>
    </main>
    <SiteFooter brand={brand} />
  </div></div>;
}
