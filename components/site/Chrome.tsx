import type { ReactNode } from "react";

/** The cube from the scene loader, reduced to a mark beside the site name. */
export function CubeMark({ size = 22 }: { size?: number }) {
  return <svg className="site-cube" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
    <path className="site-cube-top" d="M12 2.5 20.5 7.25 12 12 3.5 7.25Z" />
    <path className="site-cube-sides" d="M3.5 7.25v9.5L12 21.5l8.5-4.75v-9.5M12 12v9.5" />
  </svg>;
}

export function Wordmark({ brand, href = "/account" }: { brand: string; href?: string }) {
  return <a className="site-wordmark" href={href}><CubeMark /><span>{brand}</span></a>;
}

export type NavItem = { href: string; label: string; current?: boolean };

export function SiteFooter({ brand, links = [] }: { brand: ReactNode; links?: NavItem[] }) {
  return <footer className="site-footer">
    <span>{brand}</span>
    <nav aria-label="Legal">{links.map(link => <a key={link.href} href={link.href}>{link.label}</a>)}</nav>
  </footer>;
}

/** Section opener from the manual: a rule, a bold title, and a code on the right. */
export function SectionHeader({ title, code, strong = false, children }: { title: ReactNode; code?: string; strong?: boolean; children?: ReactNode }) {
  return <div className={`site-section${strong ? " site-section-strong" : ""}`}>
    <h2>{title}</h2>
    {children}
    {code && <span className="site-code">{code}</span>}
  </div>;
}

const statusText: Record<string, string> = {
  unpaid: "Waiting for payment", draft: "Add files", queued: "Submitted", processing: "Processing",
  ready: "Ready", failed: "Needs attention", public: "Public", private: "Private", offline: "Offline"
};

export function StatusMark({ status, label }: { status: string; label?: string }) {
  return <span className={`site-status site-status-${status}`}><i aria-hidden="true" />{label ?? statusText[status] ?? status}</span>;
}

/** Graph paper sheet with the loader's construction drawing, for sign-in and empty states. */
export function ConstructionDrawing({ className = "" }: { className?: string }) {
  return <svg className={`site-drawing ${className}`} viewBox="0 0 320 288" fill="none" aria-hidden="true" focusable="false">
    <path className="site-drawing-construction" d="M160 0V288 M0 144H320 M16 224 304 64 M16 64 304 224 M68 40V248 M252 40V248" />
    <path className="site-drawing-hidden" d="M68 196 160 144 252 196 M160 144V40" />
    <path className="site-drawing-edges" d="M160 40 252 92V196L160 248 68 196V92Z M68 92 160 144 252 92 M160 144V248" />
    <path className="site-drawing-top" d="M160 40 252 92 160 144 68 92Z" />
    <g className="site-drawing-dims">
      <path d="M52 92V196 M46 92H58 M46 196H58" /><path d="M68 264 160 264 M68 258V270 M160 258V270" />
    </g>
  </svg>;
}
