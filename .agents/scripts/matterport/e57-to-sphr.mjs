#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const sphrNextRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const repoRoot = path.resolve(sphrNextRoot, "..");
const pipeline = path.join(repoRoot, "data", "pipelines", "matterport_e57_to_sphr.py");
const requirements = path.join(repoRoot, "data", "pipelines", "requirements-matterport.txt");
const repoVenvPython = path.join(repoRoot, ".venv-matterport", "bin", "python");
const python = process.env.SPHR_MATTERPORT_PYTHON || (existsSync(repoVenvPython) ? repoVenvPython : "python3");

if (!existsSync(pipeline)) {
  console.error(`Matterport pipeline not found: ${pipeline}`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (!args.length || args.includes("--help") || args.includes("-h")) {
  console.log(`Usage:
  node .agents/scripts/matterport/e57-to-sphr.mjs --e57 data/processed/<slug>/source/<slug>.e57 --slug <slug> --title "<Title>" [pipeline args]

Notes:
  - Run this from sphr-next.
  - Paths passed to the Python pipeline are resolved from the repository root.
  - Python deps are declared in data/pipelines/requirements-matterport.txt.
  - Use SPHR_MATTERPORT_PYTHON=/path/to/python or create ../.venv-matterport.
  - Outputs are written to sphr-next/public/datasets/matterport/<slug>.`);
  process.exit(args.length ? 0 : 1);
}

const preflight = spawnSync(
  python,
  [
    "-c",
    "import numpy, PIL, pye57, open3d, trimesh",
  ],
  {
    cwd: repoRoot,
    encoding: "utf8",
  },
);

if (preflight.status !== 0) {
  const details = [preflight.stderr, preflight.stdout].filter(Boolean).join("\n").trim();
  console.error(`Matterport Python dependencies are not available for ${python}.

Install them in an isolated environment, then rerun:
  python3 -m venv ../.venv-matterport
  ../.venv-matterport/bin/python -m pip install -r ../data/pipelines/requirements-matterport.txt

Or point the wrapper at an existing environment:
  SPHR_MATTERPORT_PYTHON=/path/to/python node .agents/scripts/matterport/e57-to-sphr.mjs ...

${details}`);
  process.exit(1);
}

const child = spawn(python, [pipeline, ...args], {
  cwd: repoRoot,
  env: { ...process.env, OMP_NUM_THREADS: process.env.OMP_NUM_THREADS || "1" },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Matterport pipeline terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
