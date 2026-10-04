/**
 * Content for the "Connect an agent" band on the account page. It mirrors the spacery.dev
 * homepage (spacery/lib/agents.ts) so the setup steps stay in step across the two sites. The
 * connector files are published on the marketing site, so they are linked from there.
 */
const assetsBase = (process.env.NEXT_PUBLIC_SPACERY_SITE_URL || "https://spacery.dev").replace(/\/+$/, "");
const connectorUrl = process.env.NEXT_PUBLIC_SPACERY_CONNECTOR_URL || "https://app.spacery.dev/mcp";
export const connectorVersion = "0.2.1";
const pkg = `${assetsBase}/agents/spacery-${connectorVersion}.tgz`;

export type AgentWay = {
  label: string;
  text: string;
  /** a file to download, a command to run, or a line to paste */
  download?: { label: string; href: string };
  copy?: string;
};

export type AgentClient = { id: string; name: string; ways: AgentWay[]; ask: string };

const askLocal = "Publish the scan in my Downloads folder on Spacery.";
/** Something to ask once a space is up, for every agent. */
export const tourAsk = "Make a scavenger hunt for my kids in one of my Spacery spaces.";

export const agentClients: AgentClient[] = [
  {
    id: "claude",
    name: "Claude",
    ways: [
      { label: "Claude app", text: "Download the extension and open it, and Claude adds Spacery.", download: { label: "Download for Claude", href: `${assetsBase}/agents/spacery.mcpb` } },
      { label: "Claude Code", text: "Or run this once in a terminal.", copy: `claude mcp add --scope user spacery -- npx -y ${pkg}` }
    ],
    ask: askLocal
  },
  { id: "codex", name: "Codex", ways: [{ label: "Codex", text: "Run this once in a terminal and start a new session.", copy: `codex mcp add spacery -- npx -y ${pkg}` }], ask: askLocal },
  { id: "grok", name: "Grok", ways: [{ label: "Grok Build", text: "Run this once in a terminal and start a new session.", copy: `grok mcp add spacery -- npx -y ${pkg}` }], ask: askLocal },
  { id: "antigravity", name: "Antigravity", ways: [{ label: "Antigravity", text: "Run this once in a terminal and start a new session.", copy: `agy mcp add spacery -- npx -y ${pkg}` }], ask: askLocal },
  {
    id: "muse",
    name: "Meta Muse",
    ways: [{ label: "Meta Muse", text: "Ask Muse to add a custom connector with this address, and it sends you a page to drop big files on.", copy: connectorUrl }],
    ask: "Put the photos I just sent you on Spacery."
  },
  {
    id: "other",
    name: "Other",
    ways: [
      { label: "Any agent", text: "Paste this into your agent and it sets itself up.", copy: `Set up Spacery for me from ${assetsBase}/agents.md` },
      { label: "Connector address", text: "Apps that take a connector address can use this one.", copy: connectorUrl }
    ],
    ask: askLocal
  }
];
