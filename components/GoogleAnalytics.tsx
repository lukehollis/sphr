"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";

export default function GoogleAnalytics() {
  const pathname = usePathname();
  const measurementId = process.env.NEXT_PUBLIC_SPHR_GOOGLE_ANALYTICS_ID?.trim();

  if (!measurementId || !/^G-[A-Z0-9]+$/.test(measurementId)
    || pathname === "/admin" || pathname?.startsWith("/admin/")) return null;

  return <>
    <Script id="sphr-google-analytics" strategy="afterInteractive">{`
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());
      gtag('config', ${JSON.stringify(measurementId)});
    `}</Script>
    <Script
      id="sphr-google-analytics-loader"
      src={`https://www.googletagmanager.com/gtag/js?id=${measurementId}`}
      strategy="afterInteractive"
    />
  </>;
}
