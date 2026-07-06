#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const asJson = process.argv.includes("--json");

async function readJson(file) {
  try {
    return JSON.parse(await readFile(path.join(root, file), "utf8"));
  } catch {
    return null;
  }
}

async function listFiles(dir) {
  const absolute = path.join(root, dir);
  if (!existsSync(absolute)) return [];
  const entries = await readdir(absolute, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const rel = path.join(dir, entry.name);
      const stats = statSync(path.join(root, rel));
      return { path: rel, bytes: stats.size };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function main() {
  const pkg = await readJson("package.json");
  const dataFiles = await listFiles("lib/data");
  const demoAssets = await listFiles("public/demo");
  const claudeSkills = existsSync(path.join(root, ".claude/skills"))
    ? (await readdir(path.join(root, ".claude/skills"), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];

  const state = {
    root,
    package: pkg
      ? {
          name: pkg.name,
          next: pkg.dependencies?.next,
          spark: pkg.dependencies?.["@sparkjsdev/spark"],
          scripts: Object.keys(pkg.scripts ?? {})
        }
      : null,
    djangoRequired: false,
    defaultScene: {
      splat: demoAssets.find((asset) => asset.path.endsWith("garden_demo.spark.splat")) ?? null,
      loadingImage: demoAssets.find((asset) => asset.path.endsWith("garden_scene_splats_tour.jpg")) ?? null
    },
    dataFiles,
    demoAssets,
    claudeSkills
  };

  if (asJson) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  console.log(`SPHR Next: ${state.root}`);
  console.log(`Package: ${state.package?.name ?? "missing package.json"}`);
  console.log(`Next: ${state.package?.next ?? "missing"} | Spark: ${state.package?.spark ?? "missing"}`);
  console.log("Django required for rendering: no");
  console.log(`Demo assets: ${demoAssets.length}`);
  for (const asset of demoAssets) console.log(`  ${asset.path} (${asset.bytes} bytes)`);
  console.log(`Data files: ${dataFiles.map((file) => file.path).join(", ") || "none"}`);
  console.log(`Claude skills: ${claudeSkills.join(", ") || "none"}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
