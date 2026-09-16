import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SPHR_PUBLIC_URL || "http://localhost:3002"),
  title: "SPHR",
  description: "Animated 3D Gaussian splat, 360 panorama, and IIIF tour viewer"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="dark">
      <body>{children}</body>
    </html>
  );
}
