#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const publicExts = new Set([
  ".splat",
  ".spz",
  ".ksplat",
  ".ply",
  ".sog",
  ".rad",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".avif",
  ".mp4",
  ".webm",
  ".mp3",
  ".wav",
  ".ogg",
  ".glb",
  ".gltf"
]);

async function walk(dir) {
  const absolute = path.join(root, dir);
  if (!existsSync(absolute)) return [];
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(rel));
    } else if (publicExts.has(path.extname(entry.name).toLowerCase())) {
      const info = await stat(path.join(root, rel));
      files.push({ path: rel, bytes: info.size, ext: path.extname(entry.name).toLowerCase() });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function collectRefs(value, refs = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectRefs(item, refs));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectRefs(item, refs));
  } else if (typeof value === "string") {
    if (/(\.(splat|spz|ksplat|ply|sog|rad|jpg|jpeg|png|webp|avif|mp4|webm|mp3|wav|ogg|glb|gltf)(\?|#)?|\/iiif\/|info\.json)/i.test(value)) {
      refs.add(value);
    }
  }
  return refs;
}

async function readJsonRefs(dir) {
  if (!existsSync(path.join(root, dir))) return [];
  const refs = [];
  const entries = await readdir(path.join(root, dir), { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const rel = path.join(dir, entry.name);
    try {
      const json = JSON.parse(await readFile(path.join(root, rel), "utf8"));
      refs.push({ file: rel, refs: [...collectRefs(json)].sort() });
    } catch (error) {
      refs.push({ file: rel, error: error.message });
    }
  }
  return refs;
}

async function main() {
  const publicAssets = await walk("public");
  const dataRefs = await readJsonRefs("lib/data");
  const byExt = publicAssets.reduce((groups, asset) => {
    groups[asset.ext] ??= [];
    groups[asset.ext].push(asset);
    return groups;
  }, {});

  console.log("Public asset inventory:");
  for (const ext of Object.keys(byExt).sort()) {
    console.log(`  ${ext}`);
    for (const asset of byExt[ext]) console.log(`    ${asset.path} (${asset.bytes} bytes)`);
  }
  console.log("Referenced media in lib/data:");
  for (const item of dataRefs) {
    if (item.error) {
      console.log(`  ${item.file}: ERROR ${item.error}`);
      continue;
    }
    console.log(`  ${item.file}: ${item.refs.length ? item.refs.join(", ") : "no media refs"}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
