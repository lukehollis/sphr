// Vercel serves the application; Cloud Storage/CDN serves capture data directly.
// Explicit environment settings override these deployment defaults for other hosts.
const hosted = process.env.VERCEL === "1";
const assetBase = (process.env.SPHR_ASSET_BASE_URL || process.env.NEXT_PUBLIC_SPHR_ASSET_BASE_URL
  || (hosted ? "https://static.mused.com/sphr" : "")).replace(/\/$/, "");

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.SPHR_BUILD_DIR || ".next",
  reactStrictMode: true,
  devIndicators: false,
  allowedDevOrigins: ["local-origin.dev", "*.local-origin.dev"],
  env: {
    SPHR_ASSET_BASE_URL: assetBase,
    NEXT_PUBLIC_SPHR_ASSET_BASE_URL: assetBase,
    SPHR_CATALOG_URL: process.env.SPHR_CATALOG_URL || (assetBase ? `${assetBase}/datasets/matterport/index.json` : ""),
    SPHR_PUBLIC_URL: process.env.SPHR_PUBLIC_URL || (hosted ? "https://app.mused.com" : "http://localhost:3002")
  }
};

export default nextConfig;
