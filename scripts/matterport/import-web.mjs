#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";
const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const python = [process.env.SPHR_MATTERPORT_PYTHON, path.join(root, ".venv-matterport/bin/python"),
  path.join(root, "../.venv-matterport/bin/python")].find(p => p && existsSync(p)) ?? "python3";
const child = spawn(python, [path.join(root, "scripts/matterport/web_archive.py"), ...process.argv.slice(2)], {
  stdio: "inherit", env: { ...process.env, OMP_NUM_THREADS: process.env.OMP_NUM_THREADS || "1" }
});
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
