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

const url = argValue("--url", "http://localhost:3000");
const screenshots = process.argv.includes("--screenshots");
const artifactDir = path.join(root, "tmp", "claude-verify");

async function verifyViewport(browser, name, viewport, mobile = false) {
  const page = await browser.newPage({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  const consoleMessages = [];
  const requestFailures = [];
  page.on("console", (msg) => consoleMessages.push({ type: msg.type(), text: msg.text() }));
  page.on("requestfailed", (request) => requestFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText}`));
  page.on("pageerror", (error) => consoleMessages.push({ type: "pageerror", text: error.stack || error.message }));

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForFunction(() => {
    const button = Array.from(document.querySelectorAll("button")).find((item) => /^start$/i.test(item.textContent?.trim() || ""));
    return button && !button.disabled;
  }, null, { timeout: 120000 });
  await page.getByRole("button", { name: /^start$/i }).click({ timeout: 10000, noWaitAfter: true });
  await page.waitForTimeout(2500);

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
      debugSnapshot: window.__SPHR_RUNTIME__?.getDebugSnapshot?.() ?? null,
      resources: performance
        .getEntriesByType("resource")
        .filter((entry) => /garden|splat|spz|ksplat|iiif|jpg|png|webp|glb|gltf/i.test(entry.name))
        .map((entry) => ({ name: entry.name, encodedBodySize: entry.encodedBodySize, duration: entry.duration }))
    };
  });

  if (name === "desktop" && metrics.resources.some((entry) => /garden_demo\.spark\.splat/i.test(entry.name))) {
    metrics.clickNavigation = await page.evaluate(async () => {
      const runtime = window.__SPHR_RUNTIME__;
      if (!runtime?.raycaster || !runtime?.sceneGraph || !runtime?.canvas) return { available: false };

      const rect = runtime.canvas.getBoundingClientRect();
      const candidates = [
        [rect.width * 0.5, rect.height * 0.72],
        [rect.width * 0.45, rect.height * 0.74],
        [rect.width * 0.55, rect.height * 0.74],
        [rect.width * 0.38, rect.height * 0.68],
        [rect.width * 0.62, rect.height * 0.68],
        [rect.width * 0.5, rect.height * 0.62]
      ];
      const hits = [];
      for (const [x, y] of candidates) {
        const pointer = { x: (x / rect.width) * 2 - 1, y: -(y / rect.height) * 2 + 1 };
        runtime.raycaster.setFromCamera(pointer, runtime.camera);
        const hit = runtime.raycaster
          .intersectObjects(runtime.sceneGraph.getRaycastObjects(), true)
          .find((item) => Boolean(item.face));
        hits.push({ x, y, point: hit?.point?.toArray?.() ?? null });
      }

      const selected = hits.find((hit) => hit.point && hit.point[1] < 0);
      const before = runtime.getDebugSnapshot().camera;
      if (!selected) return { available: true, selected: null, hits, before, after: null, moved: 0 };

      const eventInit = {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
        buttons: 1,
        clientX: rect.left + selected.x,
        clientY: rect.top + selected.y
      };
      runtime.canvas.dispatchEvent(new PointerEvent("pointerdown", eventInit));
      runtime.canvas.dispatchEvent(new PointerEvent("pointerup", { ...eventInit, buttons: 0 }));
      await new Promise((resolve) => setTimeout(resolve, 1400));
      const after = runtime.getDebugSnapshot().camera;
      const moved = Math.hypot(
        after.position[0] - before.position[0],
        after.position[1] - before.position[1],
        after.position[2] - before.position[2]
      );
      return { available: true, selected, hits, before, after, moved };
    });
  }

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
      await verifyViewport(browser, "mobile", { width: 390, height: 844 }, true)
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
      ...(result.name === "desktop" &&
      result.metrics.resources.some((entry) => /garden_demo\.spark\.splat/i.test(entry.name)) &&
      !result.metrics.clickNavigation?.selected
        ? [`${result.name}: garden click navigation did not find a mesh floor target`]
        : []),
      ...(result.name === "desktop" &&
      result.metrics.resources.some((entry) => /garden_demo\.spark\.splat/i.test(entry.name)) &&
      (result.metrics.clickNavigation?.moved ?? 0) < 0.25
        ? [`${result.name}: garden click navigation did not move the camera`]
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
