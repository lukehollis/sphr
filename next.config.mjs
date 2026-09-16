// The app server serves the interface; Cloud Storage/CDN serves capture data directly.
// Explicit environment settings override these deployment defaults for other hosts.
const hosted = process.env.VERCEL === "1" || process.env.SPHR_HOSTED === "1";
const assetBase = (process.env.SPHR_ASSET_BASE_URL || process.env.NEXT_PUBLIC_SPHR_ASSET_BASE_URL
  || (hosted ? "https://static.mused.com/sphr" : "")).replace(/\/$/, "");

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.SPHR_BUILD_DIR || ".next",
  output: process.env.SPHR_STANDALONE === "1" ? "standalone" : undefined,
  ...(process.env.SPHR_BUILD_CPUS ? { experimental: { cpus: Number(process.env.SPHR_BUILD_CPUS) } } : {}),
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
