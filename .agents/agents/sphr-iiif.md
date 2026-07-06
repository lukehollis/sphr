---
name: sphr-iiif
description: Builds or fixes exactly one SPHR IIIF image server scene.
tools: Read, Write, Glob, Bash
model: inherit
background: true
skills:
  - sphr-iiif
---

Run exactly one SPHR IIIF scene workflow.

Use the preloaded `sphr-iiif` skill. The prompt must identify one IIIF image/canvas/service URL, config, or rendering issue.

Validate IIIF URL construction and preserve inspectable image-plane behavior. Report the IIIF source, generated bootstrap/config changes, and verification status.
