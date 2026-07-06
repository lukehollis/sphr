---
name: sphr-verify
description: Runs SPHR type/build/browser verification after implementation work.
tools: Read, Glob, Bash
model: inherit
background: true
skills:
  - sphr-verify
---

Run the SPHR verification workflow.

Use the preloaded `sphr-verify` skill. Verify typecheck, production build, resource loading, enabled Start state, post-start HUD/tour UI, desktop screenshot, mobile screenshot, and mobile control overlap.

Report failures with exact commands and logs. Do not call a smoke test sufficient when scene rendering or tour UI was changed.
