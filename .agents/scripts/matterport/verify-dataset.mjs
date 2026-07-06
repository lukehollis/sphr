#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const expectedMatterportFaceTransforms = [
  { skybox: 0, rotateDegrees: 90 },
  { skybox: 4, rotateDegrees: 0 },
  { skybox: 1, rotateDegrees: 0 },
  { skybox: 2, rotateDegrees: 0 },
  { skybox: 3, rotateDegrees: 0 },
  { skybox: 5, rotateDegrees: 270 },
];

const faceCenters = [
  [0, 1, 0],
  [0, 0, 1],
  [-1, 0, 0],
  [0, 0, -1],
  [1, 0, 0],
  [0, -1, 0],
];
const faceRights = [
  [-1, 0, 0],
  [-1, 0, 0],
  [0, 0, -1],
  [1, 0, 0],
  [0, 0, 1],
  [-1, 0, 0],
];
const faceUps = [
  [0, 0, -1],
  [0, 1, 0],
  [0, 1, 0],
  [0, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
];

function argValue(name, fallback) {
  const flag = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (flag) return flag.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function publicFile(webPath) {
  if (!webPath.startsWith("/")) throw new Error(`Expected an absolute public path, got ${webPath}`);
  return path.join(root, "public", webPath.replace(/^\/+/, ""));
}

function parsePoint(value) {
  if (!value) return null;
  if (value === "auto") return "auto";
  const [x, y] = value.split(",").map((item) => Number(item.trim()));
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`Expected --marker-click x,y, got ${value}`);
  return { x, y };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(a, value) {
  return [a[0] * value, a[1] * value, a[2] * value];
}

function normalize(a) {
  const length = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / length, a[1] / length, a[2] / length];
}

function chooseFace(direction) {
  const [x, y, z] = direction;
  const scores = [y, z, -x, -z, x, -y];
  return scores.indexOf(Math.max(...scores));
}

function uvForFace(face, direction) {
  const center = faceCenters[face];
  const factor = 1 / dot(center, direction);
  const point = scale(direction, factor);
  const offset = [point[0] - center[0], point[1] - center[1], point[2] - center[2]];
  return [dot(offset, faceRights[face]), dot(offset, faceUps[face])];
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sampleFace(face, u, v) {
  const x = Math.max(0, Math.min(face.width - 1, Math.round((u + 1) * 0.5 * (face.width - 1))));
  const y = Math.max(0, Math.min(face.height - 1, Math.round((1 - (v + 1) * 0.5) * (face.height - 1))));
  const offset = (y * face.width + x) * face.channels;
  return [face.data[offset] / 255, face.data[offset + 1] / 255, face.data[offset + 2] / 255];
}

function cubeSeamEdges() {
  const edges = [];
  for (let face = 0; face < 6; face += 1) {
    for (const [axis, fixed] of [
      ["u", 1],
      ["u", -1],
      ["v", 1],
      ["v", -1],
    ]) {
      const points = [];
      for (let index = 0; index < 120; index += 1) {
        const t = -0.92 + (1.84 * index) / 119;
        const u = axis === "u" ? fixed : t;
        const v = axis === "v" ? fixed : t;
        const direction = normalize(add(add(faceCenters[face], scale(faceRights[face], u)), scale(faceUps[face], v)));
        points.push({ direction, u, v });
      }
      const epsilon = scale(axis === "u" ? faceRights[face] : faceUps[face], fixed * 0.001);
      const adjacentFaces = [...new Set(points.map((point) => chooseFace(add(point.direction, epsilon))))];
      if (adjacentFaces.length === 1 && adjacentFaces[0] !== face && face < adjacentFaces[0]) {
        edges.push({ face, adjacentFace: adjacentFaces[0], points });
      }
    }
  }
  return edges;
}

async function loadSeamFace(sharp, file) {
  const { data, info } = await sharp(file)
    .resize(512, 512, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

async function validateCubePoleSeams(nodes, failures) {
  const firstNode = nodes[0];
  if (!firstNode?.faces?.length) return null;

  let sharp;
  try {
    ({ default: sharp } = await import("sharp"));
  } catch (error) {
    return validateCubePoleSeamsWithPython(firstNode, failures, error);
  }

  const faces = await Promise.all(firstNode.faces.map((face) => loadSeamFace(sharp, publicFile(face))));
  const topBottomScores = [];
  for (const edge of cubeSeamEdges()) {
    if (![0, 5].includes(edge.face) && ![0, 5].includes(edge.adjacentFace)) continue;
    const pointScores = edge.points.map((point) => {
      const first = sampleFace(faces[edge.face], point.u, point.v);
      const [adjacentU, adjacentV] = uvForFace(edge.adjacentFace, point.direction);
      const second = sampleFace(faces[edge.adjacentFace], adjacentU, adjacentV);
      return (Math.abs(first[0] - second[0]) + Math.abs(first[1] - second[1]) + Math.abs(first[2] - second[2])) / 3;
    });
    topBottomScores.push(median(pointScores));
  }

  const mean = topBottomScores.reduce((sum, score) => sum + score, 0) / topBottomScores.length;
  const max = Math.max(...topBottomScores);
  if (mean > 0.04 || max > 0.08) {
    failures.push(`Cube pole seams are misaligned for ${firstNode.uuid}: mean ${mean.toFixed(4)}, max ${max.toFixed(4)}`);
  }
  return { nodeUUID: firstNode.uuid, topBottomMean: mean, topBottomMax: max };
}

function validateCubePoleSeamsWithPython(firstNode, failures, importError) {
  const script = path.join(root, ".agents", "scripts", "matterport", "verify-cube-seams.py");
  const repoVenvPython = path.join(root, "..", ".venv-matterport", "bin", "python");
  const python = process.env.SPHR_MATTERPORT_PYTHON || (existsSync(repoVenvPython) ? repoVenvPython : "python3");
  const result = spawnSync(python, [script, ...firstNode.faces.map((face) => publicFile(face))], {
    cwd: root,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    failures.push(`Unable to run cube seam validation with sharp (${importError.message}) or ${python}:\n${details}`);
    return null;
  }

  let summary;
  try {
    summary = JSON.parse(result.stdout);
  } catch (error) {
    failures.push(`Cube seam validation returned invalid JSON: ${error.message}`);
    return null;
  }

  const mean = summary.topBottomMean;
  const max = summary.topBottomMax;
  if (mean > 0.04 || max > 0.08) {
    failures.push(`Cube pole seams are misaligned for ${firstNode.uuid}: mean ${mean.toFixed(4)}, max ${max.toFixed(4)}`);
  }
  return { nodeUUID: firstNode.uuid, topBottomMean: mean, topBottomMax: max, decoder: python };
}

async function validatePackage(configPath) {
  const bootstrapFile = configPath.startsWith("/") ? publicFile(configPath) : path.resolve(root, configPath);
  if (!existsSync(bootstrapFile)) throw new Error(`Missing bootstrap: ${bootstrapFile}`);

  const datasetDir = path.dirname(bootstrapFile);
  const manifestFile = path.join(datasetDir, "manifest.json");
  if (!existsSync(manifestFile)) throw new Error(`Missing manifest next to bootstrap: ${manifestFile}`);

  const bootstrap = await readJson(bootstrapFile);
  const manifest = await readJson(manifestFile);
  const nodes = bootstrap.space?.space_data?.nodes || [];
  const spaces = bootstrap.tour?.tour_data?.spaces || [];
  const tourpoints = spaces.flatMap((space) => space.tourpoints || []);
  const sceneGraph = bootstrap.tour?.tour_data?.sceneGraph || [];
  const meshModel = sceneGraph.find((item) => item.type === "model" && item.file);
  const failures = [];

  if (bootstrap.space?.type !== "spaces") failures.push(`Expected space.type "spaces", got ${bootstrap.space?.type}`);
  if (!nodes.length) failures.push("Bootstrap has no panorama nodes");
  if (manifest.nodeCount !== nodes.length) failures.push(`Manifest nodeCount ${manifest.nodeCount} does not match bootstrap nodes ${nodes.length}`);
  if (tourpoints.length < nodes.length) failures.push(`Expected at least one tourpoint per node, got ${tourpoints.length} for ${nodes.length} nodes`);
  if (!meshModel) failures.push("Missing model entry in tour.tour_data.sceneGraph");
  if (meshModel) {
    if (meshModel.transitionMesh !== true) failures.push("Matterport mesh must be marked transitionMesh=true");
    if (meshModel.transitionTexture !== "cube-render-target") failures.push('Matterport mesh transitionTexture must be "cube-render-target"');
    if (meshModel.fpvOpacity !== 0) failures.push(`Matterport mesh fpvOpacity must be 0 at rest, got ${meshModel.fpvOpacity}`);
    if (meshModel.raycast !== true) failures.push("Matterport mesh must be raycast=true for cursor/floor QA");
  }
  const transitionConfig = bootstrap.space?.space_data?.navigationTransition;
  if (transitionConfig?.enabled !== true) failures.push("Missing enabled space_data.navigationTransition");
  if (!transitionConfig?.meshIds?.includes?.("matterport-mesh")) {
    failures.push('space_data.navigationTransition.meshIds must include "matterport-mesh"');
  }

  let faceCount = 0;
  for (const node of nodes) {
    if (!Array.isArray(node.faces) || node.faces.length !== 6) {
      failures.push(`${node.uuid || "node"} does not have six cube faces`);
      continue;
    }
    for (const face of node.faces) {
      const faceFile = publicFile(face);
      if (!existsSync(faceFile)) failures.push(`Missing cube face: ${face}`);
      else faceCount += 1;
    }
  }

  if (manifest.imageManifest?.images2D !== faceCount) {
    failures.push(`Manifest images2D ${manifest.imageManifest?.images2D} does not match face files ${faceCount}`);
  }

  if (JSON.stringify(manifest.imageManifest?.faceTransforms) !== JSON.stringify(expectedMatterportFaceTransforms)) {
    failures.push("Manifest imageManifest.faceTransforms does not match the verified Matterport-to-SPHR cube-face transform");
  }

  let meshFile = null;
  if (meshModel) {
    meshFile = publicFile(meshModel.file);
    if (!existsSync(meshFile)) {
      failures.push(`Missing GLB model: ${meshModel.file}`);
    } else if (statSync(meshFile).size <= 0) {
      failures.push(`GLB model is empty: ${meshModel.file}`);
    }
  }

  const triangles = manifest.mesh?.triangles;
  if (typeof triangles !== "number" || triangles < 45000 || triangles > 55000) {
    failures.push(`Expected roughly 50k mesh triangles, got ${triangles}`);
  }

  const cubeSeams = await validateCubePoleSeams(nodes, failures);

  if (failures.length) {
    throw new Error(`Matterport package validation failed:\n${failures.map((item) => `  - ${item}`).join("\n")}`);
  }

  return {
    bootstrapFile,
    manifestFile,
    title: manifest.title || bootstrap.space?.title,
    slug: manifest.slug || path.basename(datasetDir),
    nodeCount: nodes.length,
    faceCount,
    tourpointCount: tourpoints.length,
    meshFile,
    meshTriangles: triangles,
    cubeSeams,
  };
}

async function verifyBrowser(appUrl, slug, screenshots, markerClick) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 });
  const consoleErrors = [];
  const requestFailures = [];
  const overlayFailures = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.stack || error.message));
  page.on("requestfailed", (request) => requestFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText}`));

  const artifactDir = path.join(root, "tmp", "claude-verify");
  const screenshotPaths = [];

  try {
    await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForFunction(() => {
      const button = Array.from(document.querySelectorAll("button")).find((item) => /^start$/i.test(item.textContent?.trim() || ""));
      return button && !button.disabled;
    }, null, { timeout: 120000 });

    const overlayState = await page.evaluate(() => {
      const visible = (element) => {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
      };
      return {
        actionsVisible: visible(document.querySelector(".loading-actions")),
        progressVisible: visible(document.querySelector(".loading-progress")),
      };
    });
    if (overlayState.actionsVisible && overlayState.progressVisible) {
      overlayFailures.push("Loading progress is visible at the same time as Start/Free Explore controls");
    }

    await page.getByRole("button", { name: /^start$/i }).click({ timeout: 10000 });
    await page.waitForSelector(".hud-left", { timeout: 30000 });
    await page.waitForFunction(() => performance.getEntriesByType("resource").some((entry) => /\.glb($|\?)/i.test(entry.name)), null, {
      timeout: 120000,
    });
    await page.waitForFunction(() => performance.getEntriesByType("resource").some((entry) => /scan-000\/face[0-5]\.jpg/i.test(entry.name)), null, {
      timeout: 120000,
    });
    await page.waitForTimeout(1000);

    if (screenshots) {
      await mkdir(artifactDir, { recursive: true });
      const screenshot = path.join(artifactDir, `matterport-${slug}-start.png`);
      await page.screenshot({ path: screenshot, fullPage: false, timeout: 120000 });
      screenshotPaths.push(screenshot);
    }

    let markerClickResult = null;
    if (markerClick) {
      const resolvedMarkerClick =
        markerClick === "auto"
          ? await page.evaluate(() => {
              const runtime = window.__SPHR_RUNTIME__;
              const navGroup = runtime?.nav?.group;
              const camera = runtime?.camera;
              const renderer = runtime?.renderer;
              const activeNode = runtime?.getActivePoint?.()?.nodeUUID;
              if (!navGroup || !camera || !renderer) return null;

              const rect = renderer.domElement.getBoundingClientRect();
              const candidates = [];
              for (const marker of navGroup.children || []) {
                const node = marker.userData?.node;
                if (!node || node.uuid === activeNode || !marker.visible) continue;
                const world = marker.position.clone();
                marker.getWorldPosition(world);
                const projected = world.clone().project(camera);
                if (projected.z < -1 || projected.z > 1) continue;
                const x = rect.left + ((projected.x + 1) / 2) * rect.width;
                const y = rect.top + ((1 - projected.y) / 2) * rect.height;
                if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
                candidates.push({
                  x,
                  y,
                  nodeUUID: node.uuid,
                  distanceToCenter: Math.hypot(x - (rect.left + rect.width / 2), y - (rect.top + rect.height / 2)),
                });
              }
              candidates.sort((a, b) => a.distanceToCenter - b.distanceToCenter);
              return candidates[0] || null;
            })
          : markerClick;
      if (!resolvedMarkerClick) throw new Error("Unable to resolve a visible marker for --marker-click auto");

      const beforeMarkerClick = await page.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .filter((entry) => /scan-\d+\/face\d\.jpg/i.test(entry.name))
          .map((entry) => entry.name)
      );
      await page.mouse.click(resolvedMarkerClick.x, resolvedMarkerClick.y);
      let transitionSnapshot = null;
      try {
        await page.waitForFunction(
          () => {
            const snapshot = window.__SPHR_RUNTIME__?.getDebugSnapshot?.();
            return (
              snapshot?.navigationTransition?.isNavigating === true &&
              snapshot?.navigationTransition?.hasCubeCamera === true &&
              snapshot?.navigationTransition?.cubeRenderTargetSize > 0 &&
              (snapshot?.sceneGraph?.transition?.activeIds || []).includes("matterport-mesh") &&
              snapshot?.sceneGraph?.transition?.opacity > 0
            );
          },
          null,
          { timeout: 5000 }
        );
        transitionSnapshot = await page.evaluate(() => window.__SPHR_RUNTIME__?.getDebugSnapshot?.()?.navigationTransition);
      } catch (error) {
        overlayFailures.push(`Marker click did not enter cube-render-target mesh transition: ${error.message}`);
      }
      await page.waitForFunction(
        (before) => {
          const previousResources = new Set(before);
          return performance
            .getEntriesByType("resource")
            .some((entry) => /scan-(?!000)\d+\/face[0-5]\.jpg/i.test(entry.name) && !previousResources.has(entry.name));
        },
        beforeMarkerClick,
        { timeout: 120000 }
      );
      await page.waitForFunction(
        () => {
          const snapshot = window.__SPHR_RUNTIME__?.getDebugSnapshot?.();
          return (
            snapshot?.navigationTransition?.isNavigating === false &&
            (snapshot?.sceneGraph?.transition?.activeIds || []).length === 0
          );
        },
        null,
        { timeout: 120000 }
      );
      await page.waitForTimeout(1000);

      const afterMarkerClick = await page.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .filter((entry) => /scan-\d+\/face\d\.jpg/i.test(entry.name))
          .map((entry) => entry.name)
      );
      markerClickResult = {
        click: resolvedMarkerClick,
        transition: transitionSnapshot,
        newFaceResources: afterMarkerClick.filter((entry) => !beforeMarkerClick.includes(entry)),
      };

      if (screenshots) {
        const screenshot = path.join(artifactDir, `matterport-${slug}-marker-click.png`);
        await page.screenshot({ path: screenshot, fullPage: false, timeout: 120000 });
        screenshotPaths.push(screenshot);
        markerClickResult.screenshot = screenshot;
      }
    }

    const nextButton = page.getByRole("button", { name: /^next$/i });
    await nextButton.click({ timeout: 10000 });
    await page.waitForFunction(() => performance.getEntriesByType("resource").some((entry) => /scan-001\/face[0-5]\.jpg/i.test(entry.name)), null, {
      timeout: 120000,
    });
    await page.waitForTimeout(1000);

    if (screenshots) {
      const screenshot = path.join(artifactDir, `matterport-${slug}-after-next.png`);
      await page.screenshot({ path: screenshot, fullPage: false, timeout: 120000 });
      screenshotPaths.push(screenshot);
    }

    const metrics = await page.evaluate(() => {
      const rectOf = (selector) => {
        const rect = document.querySelector(selector)?.getBoundingClientRect();
        return rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } : null;
      };
      const hudLeft = rectOf(".hud-left");
      const nav = rectOf(".tour-nav");
      return {
        bodyText: document.body.innerText,
        lowerControlsOverlap: Boolean(hudLeft && nav && !(hudLeft.right < nav.left || hudLeft.left > nav.right || hudLeft.bottom < nav.top || hudLeft.top > nav.bottom)),
        resources: performance
          .getEntriesByType("resource")
          .filter((entry) => /matterport|scan-|jpg|glb/i.test(entry.name))
          .map((entry) => ({ name: entry.name, encodedBodySize: entry.encodedBodySize, duration: entry.duration })),
      };
    });

    const failures = [
      ...requestFailures,
      ...consoleErrors,
      ...overlayFailures,
      ...(metrics.lowerControlsOverlap ? ["Lower controls overlap tour navigation"] : []),
    ];
    if (failures.length) {
      throw new Error(`Browser verification failed:\n${failures.map((item) => `  - ${item}`).join("\n")}`);
    }

    return { screenshots: screenshotPaths, markerClick: markerClickResult, metrics };
  } finally {
    await page.close();
    await browser.close();
  }
}

async function main() {
  if (!existsSync(path.join(root, "package.json"))) throw new Error("Run from sphr-next");
  const slug = argValue("--slug", null);
  const configPath = argValue("--config", slug ? `/datasets/matterport/${slug}/bootstrap.json` : null);
  if (!configPath) throw new Error("Provide --slug <slug> or --config /datasets/matterport/<slug>/bootstrap.json");
  const baseUrl = argValue("--url", "http://localhost:3000");
  const screenshots = process.argv.includes("--screenshots");
  const markerClick = parsePoint(argValue("--marker-click", null));
  const target = new URL(baseUrl);
  target.searchParams.set("config", configPath);

  const packageSummary = await validatePackage(configPath);
  const browserSummary = await verifyBrowser(target.toString(), packageSummary.slug, screenshots, markerClick);

  console.log(
    JSON.stringify(
      {
        url: target.toString(),
        package: packageSummary,
        browser: browserSummary,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
