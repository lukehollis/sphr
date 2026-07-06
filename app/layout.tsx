import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SPHR",
  description: "Animated 3D Gaussian splat, 360 panorama, and IIIF tour viewer"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
