import type { ReactNode } from "react";
import { CubeMark } from "./Chrome";

/** Missing pages and failures: a single sheet on graph paper with a large code. */
export default function ErrorSheet({ code, title, text, children }: { code: string; title: string; text: string; children: ReactNode }) {
  return <div className="site-error">
    <main className="site-error-sheet">
      <div className="site-error-head"><CubeMark size={28} /><span className="site-code">{code}</span></div>
      <h1>{title}</h1>
      <p>{text}</p>
      {children}
    </main>
  </div>;
}
