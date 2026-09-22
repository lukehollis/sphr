#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

function argValue(name, fallback) {
  const flag = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (flag) return flag.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const url = argValue("--url", "http://localhost:3000/?demo=garden");
const screenshots = process.argv.includes("--screenshots");
const artifactDir = path.join(root, "tmp", "claude-verify");

async function assertTourNavigation(page) {
  const bounds = await page.evaluate(() => {
    const next = document.querySelector('.tour-next');
    const rect = next?.getBoundingClientRect();
    const copy = document.querySelector('.tour-copy')?.getBoundingClientRect();
    const previous = document.querySelector('.tour-prev')?.getBoundingClientRect();
    return {
      width: innerWidth, height: innerHeight,
      next: rect?.toJSON(), copy: copy?.toJSON(), previous: previous?.toJSON(),
      visible: Boolean(rect?.width && rect?.height && getComputedStyle(next).visibility === 'visible'),
    };
  });
  const { next, previous, copy, width, height } = bounds;
  if (!bounds.visible || !next || Math.abs(next.x + next.width / 2 - width / 2) > 1
    || next.bottom > height || height - next.bottom > 64 || next.top < 0) {
    throw new Error(`HARD GATE: Next must remain visible at the bottom center: ${JSON.stringify(bounds)}`);
  }
  const overlaps = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  if (overlaps(copy, next) || overlaps(copy, previous)) {
    throw new Error(`Tour copy overlaps navigation: ${JSON.stringify(bounds)}`);
  }
  if (width <= 740 && (next.height < 72 || next.width < width - 33 || previous.bottom > next.top)) {
    throw new Error(`Mobile requires full-width 72px Next with Previous above: ${JSON.stringify(bounds)}`);
  }
  return bounds;
}

async function verifyViewport(browser, name, viewport, mobile = false) {
  const page = await browser.newPage({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  const consoleMessages = [];
  const requestFailures = [];
  page.on("console", (msg) => consoleMessages.push({ type: msg.type(), text: msg.text() }));
  page.on("requestfailed", (request) => requestFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText}`));
  page.on("pageerror", (error) => consoleMessages.push({ type: "pageerror", text: error.stack || error.message }));

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector(".viewer-header", { timeout: 120000 });
  await page.waitForFunction(() => {
    const state = JSON.parse(document.querySelector("canvas")?.dataset.sphrState || "null")?.state;
    return state?.loading.ready && !state.navigating && !document.querySelector(".scene-load-status");
  }, null, { timeout: 120000 });
  const guidedAvailable = await page.locator('.sphr-root.has-guided-tour').count() > 0;

  const metrics = await page.evaluate(() => {
    const rectOf = (selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } : null;
    };
    const hudLeft = rectOf(".hud-left");
    const nav = rectOf(".tour-nav");
    const lowerControlsOverlap =
      Boolean(hudLeft && nav && !(hudLeft.right < nav.left || hudLeft.left > nav.right || hudLeft.bottom < nav.top || hudLeft.top > nav.bottom));
    return {
      bodyText: document.body.innerText,
      hudLeft,
      nav,
      lowerControlsOverlap,
      debugSnapshot: JSON.parse(document.querySelector("canvas")?.getAttribute("data-sphr-state") || "null"),
      guideButtonCount: document.querySelectorAll('[role="switch"][aria-label="Guide"]').length,
      resources: performance
        .getEntriesByType("resource")
        .filter((entry) => /garden|splat|spz|ksplat|iiif|jpg|png|webp|glb|gltf/i.test(entry.name))
        .map((entry) => ({ name: entry.name, encodedBodySize: entry.encodedBodySize, duration: entry.duration }))
    };
  });

  if (metrics.guideButtonCount !== Number(guidedAvailable)) {
    throw new Error("Guided controls do not match the automatically started scene mode");
  }
  if (metrics.debugSnapshot?.state.guided !== guidedAvailable || await page.locator('.loading-actions').count()) {
    throw new Error("Scene must automatically start its available tour or free exploration without an entrance gate");
  }
  if (guidedAvailable) {
    metrics.tourNavigation = await assertTourNavigation(page);
    // Check movement as well as the settled frame: navigation must not disappear.
    await page.locator('.tour-next').click();
    if (await page.locator('.tour-next').count()) await assertTourNavigation(page);
    await page.waitForFunction(() => !JSON.parse(document.querySelector('[data-sphr-session]').dataset.sphrSession).navigating);
    const stillGuided = await page.locator('.tour-next').count() > 0;
    if (stillGuided) {
      await assertTourNavigation(page);
      await page.locator('.tour-prev').click();
      await page.waitForFunction(() => !JSON.parse(document.querySelector('[data-sphr-session]').dataset.sphrSession).navigating);
      await assertTourNavigation(page);
    }
    if (stillGuided) {
      if (await page.getByRole("button", { name: "Switch to orbit view", exact: true }).count()) throw new Error("Dollhouse must be hidden in guided mode");
      await page.getByRole("switch", { name: "Guide", exact: true }).click();
    }
  }
  await page.getByRole("button", { name: "Switch to orbit view", exact: true }).click();
  await page.waitForFunction(() => JSON.parse(document.querySelector("canvas").dataset.sphrState).state.viewMode === "ORBIT");
  await page.waitForTimeout(1400);
  if (screenshots) {
    await mkdir(artifactDir, { recursive: true });
    await page.screenshot({ path: path.join(artifactDir, `${name}-overview.png`) });
  }
  await page.mouse.dblclick(viewport.width * 0.9, viewport.height * 0.25);
  await page.waitForFunction(() => {
    const state = JSON.parse(document.querySelector("canvas").dataset.sphrState).state;
    return state.viewMode === "FPV" && !state.navigating;
  }, null, { timeout: 120000 });
  metrics.overviewDoubleClick = "returned to FPV";

  let screenshot = null;
  if (screenshots) {
    await mkdir(artifactDir, { recursive: true });
    screenshot = path.join(artifactDir, `${name}.png`);
    await page.screenshot({ path: screenshot, fullPage: false, timeout: 300000 });
  }

  await page.close();
  return {
    name,
    screenshot,
    requestFailures,
    metrics,
    consoleMessages: consoleMessages.filter((msg) => msg.type === "error" || msg.type === "pageerror")
  };
}

async function main() {
  if (!existsSync(path.join(root, "package.json"))) throw new Error("Run from sphr-next");
  const browser = await chromium.launch({ headless: true });
  try {
    const results = [
      await verifyViewport(browser, "desktop", { width: 1440, height: 980 }),
      await verifyViewport(browser, "desktop-narrow", { width: 741, height: 720 }),
      await verifyViewport(browser, "mobile-breakpoint", { width: 740, height: 720 }, true),
      await verifyViewport(browser, "mobile", { width: 390, height: 844 }, true),
      await verifyViewport(browser, "mobile-small", { width: 320, height: 720 }, true)
    ];
    const failures = results.flatMap((result) => [
      ...result.requestFailures.map((failure) => `${result.name}: ${failure}`),
      ...(result.metrics.lowerControlsOverlap ? [`${result.name}: lower controls overlap tour navigation`] : []),
      ...(result.metrics.resources.some((entry) => /garden_demo\.spark\.splat/i.test(entry.name)) &&
      (result.metrics.debugSnapshot?.splats?.splats?.[0]?.numSplats ?? 0) < 3810048
        ? [`${result.name}: garden Spark splat is not full resolution`]
        : []),
      ...(result.metrics.resources.some((entry) => /garden_demo\.spark\.splat/i.test(entry.name)) &&
      !result.metrics.debugSnapshot?.skybox?.loaded
        ? [`${result.name}: garden skybox did not load`]
        : []),
      ...(result.metrics.resources.some((entry) => /garden_demo\.spark\.splat/i.test(entry.name)) &&
      (result.metrics.debugSnapshot?.skybox?.opacity ?? 0) < 0.99
        ? [`${result.name}: garden skybox is not visible`]
        : []),
      ...(result.metrics.resources.some((entry) => /garden_demo\.spark\.splat/i.test(entry.name)) &&
      Math.abs((result.metrics.debugSnapshot?.camera?.fov ?? 0) - 70) > 0.01
        ? [`${result.name}: garden camera FOV does not match legacy 70 degree setup`]
        : []),
      ...result.consoleMessages.map((msg) => `${result.name}: ${msg.text}`)
    ]);
    console.log(JSON.stringify({ url, screenshots, results }, null, 2));
    if (failures.length) {
      console.error("Verification failures:");
      failures.forEach((failure) => console.error(`  - ${failure}`));
      process.exit(1);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
