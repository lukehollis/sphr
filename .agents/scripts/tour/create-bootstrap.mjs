#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

function argValue(name, fallback) {
  const flag = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (flag) return flag.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function slugify(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "sphr-scene";
}

const type = argValue("--type", "splat");
const title = argValue("--title", "SPHR Scene");
const slug = argValue("--slug", slugify(title));
const out = argValue("--out", `public/configs/${slug}.json`);

const baseTourPoint = {
  id: `${slug}-intro`,
  text: title,
  viewMode: "FPV",
  targetType: "FREE",
  position: { x: 0, y: 1.5, z: 4 },
  rotation: { azimuth: 0, polar: 0 },
  zoom: 0,
  files: [],
  models: [],
  annotations: [],
  sounds: []
};

const config = {
  space: {
    id: slug,
    title,
    type,
    mesh: null,
    version: null,
    space_custom: slug,
    space_data: {
      title,
      initialPosition: { x: 0, y: 1.5, z: 4 },
      initialRotation: { azimuth: 0, polar: 0 }
    }
  },
  tour: {
    id: `${slug}-tour`,
    title,
    tour_data: {
      defaultShowText: true,
      spaces: [
        {
          id: slug,
          title,
          type,
          tourpoints: [baseTourPoint]
        }
      ]
    }
  },
  ui: {
    titlePart1: "Explore",
    titlePart2: title,
    subtitle: "",
    enterButtonText: "Start",
    exploreButtonText: "Free Explore",
    loadingText: "Loading",
    nextButtonText: "Next",
    previousButtonText: "Previous",
    continueExploringButtonText: "Continue Exploring"
  }
};

if (type === "splat") {
  const splatUrl = argValue("--splat-url", "/demo/garden_demo.spark.splat");
  config.space.space_data.splats = [
    {
      id: `${slug}-splat`,
      url: splatUrl,
      lod: false,
      reveal: true,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: 1
    }
  ];
} else if (type === "spaces" || type === "360") {
  config.space.type = "spaces";
  config.space.space_data.initialNode = `${slug}-node-0`;
  config.space.space_data.nodes = [
    {
      uuid: `${slug}-node-0`,
      image: argValue("--pano-url", "/demo/pano.jpg"),
      position: { x: 0, y: 1.5, z: 0 },
      rotation: { x: 0, y: 0, z: 0 }
    }
  ];
  config.tour.tour_data.spaces[0].type = "spaces";
  config.tour.tour_data.spaces[0].tourpoints[0].nodeUUID = `${slug}-node-0`;
  config.tour.tour_data.spaces[0].tourpoints[0].targetType = "NODE";
} else if (type === "iiif") {
  const iiifUrl = argValue("--iiif-url", "https://example.org/iiif/image/full/1200,/0/default.jpg");
  config.space.src = iiifUrl;
  config.space.space_data.iiif = {
    id: `${slug}-iiif`,
    url: iiifUrl,
    position: [0, 2, -4],
    scale: 1
  };
} else {
  console.error(`Unsupported --type ${type}. Use splat, spaces, 360, or iiif.`);
  process.exit(1);
}

const absoluteOut = path.resolve(root, out);
await mkdir(path.dirname(absoluteOut), { recursive: true });
await writeFile(absoluteOut, `${JSON.stringify(config, null, 2)}\n`);
console.log(path.relative(root, absoluteOut));
