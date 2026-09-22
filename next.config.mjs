import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Mounted local captures and the application must share Turbopack's filesystem root.
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
let turbopackRoot = projectRoot;
try {
  const captureRoot = realpathSync(path.join(projectRoot, "public/datasets/matterport"));
  while (path.relative(turbopackRoot, captureRoot).split(path.sep)[0] === "..") {
    turbopackRoot = path.dirname(turbopackRoot);
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

// The app server serves the interface; Cloud Storage/CDN serves capture data directly.
// A clean checkout uses local assets; each deployment supplies its own origins.
const assetBase = (process.env.SPHR_ASSET_BASE_URL || process.env.NEXT_PUBLIC_SPHR_ASSET_BASE_URL
  || "").replace(/\/$/, "");

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.SPHR_BUILD_DIR || ".next",
  turbopack: { root: turbopackRoot },
  output: process.env.SPHR_STANDALONE === "1" ? "standalone" : undefined,
  ...(process.env.SPHR_BUILD_CPUS ? { experimental: { cpus: Number(process.env.SPHR_BUILD_CPUS) } } : {}),
  reactStrictMode: true,
  devIndicators: false,
  allowedDevOrigins: ["local-origin.dev", "*.local-origin.dev"],
  async headers() {
    return [{ source: "/admin/:path*", headers: [
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "same-origin" }
    ] }];
  },
  env: {
    SPHR_ASSET_BASE_URL: assetBase,
    NEXT_PUBLIC_SPHR_ASSET_BASE_URL: assetBase,
    SPHR_CATALOG_URL: process.env.SPHR_CATALOG_URL || (assetBase ? `${assetBase}/datasets/matterport/index.json` : ""),
    SPHR_PUBLIC_URL: process.env.SPHR_PUBLIC_URL || "http://localhost:3002"
  }
};

export default nextConfig;
