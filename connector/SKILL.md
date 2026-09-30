---
name: {{slug}}
description: Publish 3D captures from this computer as {{name}} spaces, such as E57 and other laser scans, Matterport exports, Gaussian splats, 360 photos and video, meshes and photo sets. Use when the person wants to host, share, upload or publish a capture or a virtual tour on {{name}}.
---

# Publish a capture on {{name}}

{{name}} ({{site}}) hosts 3D captures as virtual spaces with guided tours, shared with a link. Its connector
uploads files straight from this computer, resumes after interruptions and keeps going if the chat ends.

## With the MCP tools

1. `check_files` on the files or folders the person names. If they are vague, ask where the capture is
   instead of searching their disk. One capture is one space.
2. `link_account` when not linked. A browser page opens where the person approves a short code.
   Never ask for a password.
3. Before the first space, `list_plans` and let the person choose. Pay as you go is the default.
4. `create_space` with the suggested title. If hosting needs payment, Stripe Checkout opens in the
   browser for the person to pay. Never ask for card details. Then `wait_for_payment`.
5. `upload_files` with every file of the capture in one call, with `notes` when the person says what the
   capture is or how the tour should go. It returns at once and submits the space when the upload ends.
6. Tell the person roughly how long the upload will take (`space_status`) and that {{name}} emails them
   when the space is ready. Spaces start private; `set_visibility` only when they ask to share.

## Without the MCP tools loaded

The same tools run from a shell, which helps right after installing, before the agent reloads its MCP
servers. Arguments are JSON.

```bash
npx -y {{package}} call check_files '{"paths":["/path/to/capture"]}'
npx -y {{package}} call link_account
npx -y {{package}} call list_plans
npx -y {{package}} call create_space '{"title":"Riverside studio"}'
npx -y {{package}} call wait_for_payment '{"space_id":"<id>"}'
npx -y {{package}} call upload_files '{"space_id":"<id>","paths":["/path/to/capture"]}'
npx -y {{package}} call space_status '{"space_id":"<id>"}'
```

Agents that run in the cloud and cannot reach this computer can use the hosted connector at {{url}}/mcp.
