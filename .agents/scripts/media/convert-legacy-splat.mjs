#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const converter = path.join(root, "scripts", "convert-legacy-splat.mjs");

if (process.argv.length < 4) {
  console.error("Usage: node .claude/scripts/media/convert-legacy-splat.mjs <legacy.splat> <output.splat> [--max-splats=N] [--min-alpha=N]");
  process.exit(1);
}

const child = spawn(process.execPath, [converter, ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Converter terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});
