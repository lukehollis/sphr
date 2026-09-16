#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const python = process.env.SPHR_MATTERPORT_PYTHON || [".venv-matterport/bin/python", "../.venv-matterport/bin/python"].find(existsSync) || "python3";
const tests = spawnSync(python, ["-m", "unittest", "discover", "-s", "scripts/matterport", "-p", "test_*.py", "-v"], { stdio: "inherit" });
if (tests.status !== 0) process.exit(tests.status ?? 1);
const dataset = process.argv[2] ?? "public/datasets/matterport/loomis-observatory";
if (!existsSync(path.join(dataset, "manifest.json"))) {
  console.log("Geometry regressions passed. Supply a migrated dataset path for full asset validation.");
} else {
  const check = spawnSync(python, ["scripts/matterport/validate.py", dataset], { encoding: "utf8" });
  if (check.status !== 0) { console.error(check.stderr); process.exit(check.status ?? 1); }
  const report = JSON.parse(check.stdout);
  console.log(JSON.stringify({ ...report, scans: `${report.scans.length} scans checked` }, null, 2));
}
