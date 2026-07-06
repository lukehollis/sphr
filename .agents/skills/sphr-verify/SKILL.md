---
name: sphr-verify
description: Run complete SPHR Next verification for renderer, tour, layout, asset, and production-build changes.
argument-hint: [optional --url URL]
allowed-tools: Read Glob Bash(ls *) Bash(node .claude/scripts/project/sphr-state.mjs *) Bash(node .claude/scripts/project/asset-inventory.mjs *) Bash(node .claude/scripts/project/validate-bootstrap.mjs *) Bash(node .claude/scripts/project/verify-app.mjs *) Bash(npm run typecheck *) Bash(npm run build *) Bash(lsof *)
agent: sphr-verify
---

Use this after SPHR implementation work. Do not reduce it to a smoke test when rendering or tour UI changed.

## Verification Steps

1. Inspect project state:

```bash
node .claude/scripts/project/sphr-state.mjs
node .claude/scripts/project/asset-inventory.mjs
node .claude/scripts/project/validate-bootstrap.mjs
```

2. Ensure a dev server is running for browser verification:

```bash
lsof -i :3000 -sTCP:LISTEN -n -P
npm run dev -- --port 3000
```

3. Run code checks:

```bash
npm run typecheck
npm run build
```

4. Run browser checks:

```bash
node .claude/scripts/project/verify-app.mjs --url http://localhost:3000 --screenshots
```

For a config-specific scene:

```bash
node .claude/scripts/project/verify-app.mjs --url "http://localhost:3000/?config=/configs/<scene>.json" --screenshots
```

## Pass Criteria

- No type/build failures.
- Bootstrap assets exist.
- No failed resource requests.
- Start button becomes enabled.
- Starting the scene mounts HUD/tour controls.
- Desktop and mobile screenshots are produced.
- Mobile lower HUD controls do not overlap tour navigation.
- Any remaining console warnings are understood and reported.

Final response should list the exact commands run, pass/fail status, screenshot paths when generated, and any residual warnings.
