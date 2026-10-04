import type { Metadata } from "next";
import Analytics from "@/components/Analytics";
import GoogleAnalytics from "@/components/GoogleAnalytics";
import { siteBrand } from "@/lib/server/brand";
import { missingPartScript } from "@/lib/missing-part";
import "./globals.css";

// The site's own name (a deployment's brand) in the browser tab, read when the page is served.
export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(process.env.SPHR_PUBLIC_URL || "http://localhost:3002"),
    title: siteBrand(),
    description: "Animated 3D Gaussian splat, 360 panorama, and IIIF tour viewer"
  };
}

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="dark">
      <head><script dangerouslySetInnerHTML={{ __html: missingPartScript(process.env.NEXT_PUBLIC_SPHR_ANALYTICS === "1") }} /></head>
      <body>{children}<GoogleAnalytics /><Analytics /></body>
    </html>
  );
}
