#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const target = process.argv[2];
const errors = [];
const warnings = [];

function localPublicExists(url) {
  if (!url || typeof url !== "string" || !url.startsWith("/") || url.startsWith("//")) return true;
  return existsSync(path.join(root, "public", url));
}

function checkLocal(url, label) {
  if (!localPublicExists(url)) errors.push(`${label} does not exist under public/: ${url}`);
}

function validateBootstrap(config) {
  const space = config.space;
  if (!space) errors.push("Missing space");
  if (!space?.space_data) errors.push("Missing space.space_data");

  const type = space?.type ?? "spaces";
  if (space?.space_data?.splats?.length) {
    for (const [index, splat] of space.space_data.splats.entries()) {
      if (!splat.url) errors.push(`space.space_data.splats[${index}] missing url`);
      checkLocal(splat.url, `splat ${splat.id ?? index}`);
      if (splat.url && !/\.(splat|spz|ksplat|ply|sog|rad)(\?|#|$)/i.test(splat.url)) {
        warnings.push(`splat ${splat.id ?? index} has an unusual extension: ${splat.url}`);
      }
    }
  } else if (type === "splat") {
    warnings.push("space.type is splat but no space.space_data.splats were provided");
  }

  const nodes = space?.space_data?.nodes ?? space?.space_data?.navPoints ?? [];
  if (type === "spaces" && !nodes.length) warnings.push("360 space has no nodes/navPoints");
  for (const [index, node] of nodes.entries()) {
    if (!node.uuid) errors.push(`node[${index}] missing uuid`);
    if (!node.position) errors.push(`node[${index}] missing position`);
    if (node.image) checkLocal(node.image, `node ${node.uuid ?? index} image`);
    for (const [faceIndex, face] of [...(node.faces ?? []), ...(node.cubeFaces ?? [])].entries()) {
      checkLocal(face, `node ${node.uuid ?? index} face ${faceIndex}`);
    }
  }

  const iiif = space?.space_data?.iiif;
  if (type === "iiif" && !iiif && !space.src) warnings.push("IIIF space has no space.src or space.space_data.iiif");

  const tourSpaces = config.tour?.tour_data?.spaces ?? config.tour?.tour_data?.tourmodels ?? [];
  if (config.tour && !tourSpaces.length) warnings.push("tour exists but has no tour_data.spaces/tourmodels");
  for (const [spaceIndex, tourSpace] of tourSpaces.entries()) {
    if (!Array.isArray(tourSpace.tourpoints)) errors.push(`tour space[${spaceIndex}] missing tourpoints array`);
  }
}

async function main() {
  if (!target) {
    checkLocal("/demo/garden_demo.spark.splat", "default garden splat");
    checkLocal("/demo/garden_scene_splats_tour.jpg", "default loading image");
    if (!existsSync(path.join(root, "lib/bootstrap.ts"))) errors.push("Missing lib/bootstrap.ts");
  } else {
    const absolute = path.resolve(root, target);
    const config = JSON.parse(await readFile(absolute, "utf8"));
    validateBootstrap(config);
  }

  if (warnings.length) {
    console.log("Warnings:");
    warnings.forEach((warning) => console.log(`  - ${warning}`));
  }
  if (errors.length) {
    console.error("Errors:");
    errors.forEach((error) => console.error(`  - ${error}`));
    process.exit(1);
  }
  console.log(target ? `Bootstrap valid: ${target}` : "Default bootstrap assets valid");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
