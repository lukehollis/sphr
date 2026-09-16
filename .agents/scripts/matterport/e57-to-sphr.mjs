#!/usr/bin/env node
// Compatibility entry point; the distributable importer lives in scripts/matterport.
// Preserve legacy path resolution from the parent workspace.
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("../../../..", import.meta.url)));
await import("../../../scripts/matterport/import.mjs");
