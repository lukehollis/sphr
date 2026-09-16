#!/usr/bin/env node
// Optional authored-tour composition. Does not modify the imported source package.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import path from "node:path";

const { values } = parseArgs({ options: {
  input: { type: "string" }, stops: { type: "string" }, out: { type: "string" }, title: { type: "string" }
} });
if (!values.input || !values.stops || !values.out) throw new Error("Required: --input bootstrap.json --stops stops.json --out a-new-config.json [--title Title]");
if (path.resolve(values.input) === path.resolve(values.out)) throw new Error("Output must differ from the imported bootstrap");
const [bootstrap, stops] = await Promise.all([values.input, values.stops].map(async file => JSON.parse(await readFile(file, "utf8"))));
if (!Array.isArray(stops) || !stops.length) throw new Error("Stops must be a nonempty JSON array");
const nodes = bootstrap.space.space_data.nodes ?? bootstrap.space.space_data.navPoints ?? [];
const byId = new Map(nodes.map(node => [node.uuid, node]));
const sourceTour = bootstrap.tour?.tour_data ?? {};
const sourcePoints = (sourceTour.spaces ?? sourceTour.tourmodels ?? []).flatMap(space => space.tourpoints ?? []);
const points = stops.map((stop, index) => {
  const node = byId.get(stop.nodeUUID);
  if (!node) throw new Error(`Unknown node at stop ${index}: ${stop.nodeUUID}`);
  const existing = sourcePoints.find(point => point.nodeUUID === node.uuid);
  const rotation = stop.rotation ?? existing?.rotation ?? node.initialRotation ?? bootstrap.space.space_data.initialRotation;
  if (rotation && ![rotation.azimuth, rotation.polar].every(Number.isFinite)) throw new Error(`Invalid rotation at stop ${index}`);
  if (stop.zoom !== undefined && !Number.isFinite(stop.zoom)) throw new Error(`Invalid zoom at stop ${index}`);
  return { ...existing, ...stop, id: stop.id ?? `authored-${index}`, nodeUUID: node.uuid,
    targetType: "NODE", viewMode: "FPV", rotation, zoom: stop.zoom ?? existing?.zoom ?? 0 };
});
bootstrap.tour = { ...bootstrap.tour, title: values.title ?? bootstrap.space.title,
  tour_data: { ...sourceTour, mode: "guided", defaultShowText: points.some(point => Boolean(point.text || point.secondaryText || point.files?.length)),
    spaces: [{ id: bootstrap.space.id, title: bootstrap.space.title, tourpoints: points }] } };
await mkdir(path.dirname(path.resolve(values.out)), { recursive: true });
await writeFile(values.out, JSON.stringify(bootstrap, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ output: path.resolve(values.out), stops: points.length, mode: "guided", sourceUnchanged: true }));
