#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const candidates = [process.env.SPHR_MATTERPORT_PYTHON, path.join(root, ".venv-matterport/bin/python"), path.join(root, "../.venv-matterport/bin/python")];
const python = candidates.find((item) => item && existsSync(item)) ?? "python3";
const args = process.argv.slice(2);
const result = spawnSync(python, ["-c", "import numpy, PIL, pye57, open3d, trimesh, scipy, xatlas"], { encoding: "utf8" });
if (result.status !== 0) {
  console.error("Install the importer dependencies:\n  python3 -m venv .venv-matterport\n  .venv-matterport/bin/pip install -r scripts/matterport/requirements.txt\nOr set SPHR_MATTERPORT_PYTHON to an existing environment.");
  process.exit(1);
}
const child = spawn(python, [path.join(root, "scripts/matterport/converter.py"), ...args], {
  cwd: process.cwd(), env: { ...process.env, OMP_NUM_THREADS: process.env.OMP_NUM_THREADS || "1" }, stdio: "inherit"
});
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
