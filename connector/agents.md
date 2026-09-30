# {{name}} for agents

{{name}} hosts 3D captures (E57 and other laser scans, Matterport exports, Gaussian splats, 360 photos and
video, meshes and photo sets) as virtual spaces with guided tours, shared with a link. This page is for
agents. It shows how to add the {{name}} connector so you can publish captures for the person you are
helping, straight from their computer.

The connector is a small MCP server with no dependencies. It needs Node.js 18 or later (`node --version`).
It links to the person's account through a code they approve in their browser, opens Stripe Checkout in
their browser when hosting needs payment, and uploads in the background with resume. It never sees a
password or a card. The package is one readable JavaScript file with no dependencies.

## Add it

Claude Desktop. Download {{site}}/agents/{{slug}}.mcpb and open it. Claude asks to install the extension.

Claude Code.

```bash
claude mcp add --scope user {{slug}} -- npx -y {{package}}
```

Codex.

```bash
codex mcp add {{slug}} -- npx -y {{package}}
```

Grok Build.

```bash
grok mcp add {{slug}} -- npx -y {{package}}
```

Antigravity.

```bash
agy mcp add {{slug}} -- npx -y {{package}}
```

Or open Manage MCP Servers, choose View raw config (`~/.gemini/config/mcp_config.json`) and add

```json
{
  "mcpServers": {
    "{{slug}}": { "command": "npx", "args": ["-y", "{{package}}"] }
  }
}
```

Any other agent that runs local MCP servers uses the command `npx` with the arguments `-y {{package}}`.
After adding it, reload the agent's MCP servers or start a new session.

Agents that keep skills can also save {{site}}/agents/SKILL.md as `{{slug}}/SKILL.md` in their skills
folder (`~/.claude/skills`, `~/.agents/skills` for Codex, `~/.grok/skills`, `~/.gemini/config/skills` for
Antigravity).

## Agents in the cloud

Meta Muse, claude.ai, ChatGPT, grok.com and other apps that take a connector URL can add the hosted
connector at {{url}}/mcp. It cannot read files on the person's computer. It links the account, handles
Checkout and takes files the agent holds itself (photos or video the person shared with it) through
resumable uploads, and for files on the person's own devices it gives them a page to drop them on.

## Publish a capture

1. `check_files` on the files or folders the person names. If they are vague, ask where the capture is.
2. `link_account`, then the person approves the code in their browser.
3. Before the first space, `list_plans` and let the person choose. Pay as you go is the default.
4. `create_space`. When payment is needed, Stripe Checkout opens for the person; then `wait_for_payment`.
5. `upload_files` with every file of the capture in one call. It submits the space when the upload ends.
6. Tell the person the upload is running and that {{name}} emails them when the space is ready.

Before the MCP tools are loaded, the same tools run from a shell, for example
`npx -y {{package}} call check_files '{"paths":["/path/to/capture"]}'`.
