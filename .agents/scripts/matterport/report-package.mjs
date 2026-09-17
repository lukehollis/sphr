#!/usr/bin/env node
// Summarize real stored receipts; use validate.py for fresh all-image/source validation.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const folder = process.argv[2];
if (!folder) throw new Error("Usage: node .agents/scripts/matterport/report-package.mjs <dataset-directory>");
const read = async name => JSON.parse(await readFile(path.join(folder, name), "utf8"));
const [manifest, bootstrap, quality, validation] = await Promise.all(["manifest.json", "bootstrap.json", "quality.json", "validation.json"].map(read));
if (!validation.passed) throw new Error("Stored package validation did not pass");
const mesh = await readFile(path.join(folder, "mesh", `${manifest.slug}-50k.glb`));
if (manifest.mesh.sha256 && createHash("sha256").update(mesh).digest("hex") !== manifest.mesh.sha256) throw new Error("Mesh changed since validation");
const nodes = bootstrap.space.space_data.nodes;
const photoErrors = quality.scans.map(scan => scan.photoMedianAbsoluteError).filter(Number.isFinite);
const heights = quality.scans.map(scan => scan.floor.cameraHeight).filter(Number.isFinite);
console.log(JSON.stringify({
  title: manifest.title, source: manifest.source, sourceSha256: manifest.sourceSha256,
  sourceParts: manifest.sourceParts ?? [], scenePath: manifest.scenePath,
  bootstrapUrl: manifest.bootstrapUrl, scans: nodes.length, faces: nodes.length * 6,
  faceSizes: [...new Set(Object.values(manifest.imageManifest.groups).flatMap(group => group.sourceFaces.map(face => face.size.join("x"))))],
  mesh: { triangles: manifest.mesh.triangles, bytes: mesh.length, bounds: manifest.mesh.bounds, texture: manifest.mesh.texture },
  mode: bootstrap.tour?.tour_data?.mode ?? "unspecified",
  scaleMaxErrorMeters: validation.scaleMaxErrorMeters,
  worstScanPhotoMedianError: photoErrors.length ? Math.max(...photoErrors) : null,
  pointToMeshMeters: quality.pointToMeshMeters,
  cameraHeightMeters: heights.length ? { min: Math.min(...heights), max: Math.max(...heights) } : null,
  cameraPointNodes: nodes.filter(node => node.floorUnobserved).map(node => node.uuid),
  components: quality.navigation.components.map(component => component.length),
  isolatedNodes: quality.navigation.isolatedNodes,
  seamMax: validation.seamMax, warnings: validation.warnings ?? [],
  storedValidation: { passed: validation.passed, sourceVerified: validation.sourceVerified ?? null },
  note: "Counts and quality are stored import receipts; mesh hash checked now. Run validate.py for fresh source and image checks."
}, null, 2));
