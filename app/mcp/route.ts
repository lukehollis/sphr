import { createMcpSession, deleteMcpSession, readMcpSession } from "@/lib/server/accounts-store";
import { accountsEnabled, bearerToken } from "@/lib/server/accounts";
import { hostedInstructions, hostedTools, runHostedTool, type McpContext } from "@/lib/server/agent-mcp";
import { siteBrand } from "@/lib/server/brand";

// The hosted MCP endpoint (Streamable HTTP, JSON responses) for agents that run in the cloud and
// take a connector URL. Agents on the person's own computer use the local connector instead.
// A linked agent authenticates with its bearer token, or with the Mcp-Session-Id it was given,
// which holds the token it linked in that session.

export const dynamic = "force-dynamic";
const supportedVersions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const known: Record<string, string> = { "claude-ai": "Claude", claude: "Claude", openai: "ChatGPT", chatgpt: "ChatGPT", "openai-mcp": "ChatGPT",
  grok: "Grok", xai: "Grok", muse: "Meta Muse", "meta-muse": "Meta Muse", meta: "Meta Muse" };

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

function clientName(info: unknown) {
  const raw = typeof info === "object" && info && "name" in info ? String((info as { name: unknown }).name).slice(0, 60) : "";
  return (known[raw.toLowerCase()] ?? raw.replace(/[-_]+/g, " ").replace(/\b(mcp|client)\b/gi, "").trim()) || "An agent";
}

async function answer(message: Message, context: McpContext) {
  const { id, method, params } = message;
  const result = (value: object) => ({ jsonrpc: "2.0", id, result: value });
  const error = (code: number, text: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message: text } });
  switch (method) {
    case "initialize":
      return result({ protocolVersion: supportedVersions.includes(String(params?.protocolVersion)) ? params!.protocolVersion : supportedVersions[0],
        capabilities: { tools: {} }, serverInfo: { name: "sphr", title: siteBrand(), version: "1.0.0" }, instructions: hostedInstructions() });
    case "ping": return result({});
    case "tools/list": return result({ tools: hostedTools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const outcome = await runHostedTool(String(params?.name ?? ""), (params?.arguments ?? {}) as Record<string, unknown>, context);
      if ("error" in outcome) return error(-32602, outcome.error!);
      return result({ content: [{ type: "text", text: outcome.text }], ...(outcome.isError ? { isError: true } : {}) });
    }
    case "prompts/list": return result({ prompts: [] });
    case "resources/list": return result({ resources: [] });
    case "resources/templates/list": return result({ resourceTemplates: [] });
    default: return error(-32601, `Method not found: ${method}`);
  }
}

export async function POST(request: Request) {
  if (!accountsEnabled()) return Response.json({ error: "Accounts are unavailable." }, { status: 404, headers });
  const text = await request.text();
  if (text.length > 256 * 1024) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } }, { status: 413, headers });
  let parsed: Message | Message[];
  try { parsed = JSON.parse(text); } catch { return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400, headers }); }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const initialize = messages.find(message => message?.method === "initialize");

  // A bearer token names the account outright. Otherwise the session holds what was linked in it.
  const token = bearerToken(request);
  if (token !== undefined && !/^sphr_[a-f0-9]{64}$/.test(token)) {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Invalid token" } }, { status: 401, headers });
  }
  let sessionId = request.headers.get("mcp-session-id") ?? undefined;
  let session = sessionId ? readMcpSession(sessionId) : undefined;
  if (sessionId && !session && !initialize) {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session not found. Initialize again." } }, { status: 404, headers });
  }
  if (initialize) {
    sessionId = createMcpSession(clientName(initialize.params?.clientInfo));
    session = readMcpSession(sessionId);
  }
  const context: McpContext = { request, client: session?.client ?? "An agent", sessionId: session ? sessionId : undefined,
    secret: { token: session?.token, link: session?.link }, token: token ?? session?.token };

  const replies = [];
  for (const message of messages) {
    if (!message || typeof message !== "object" || message.id === undefined || !message.method) continue; // notifications and client responses
    // Tools see the latest session state, including a token linked by an earlier message in this batch.
    if (context.sessionId && !token) {
      const current = readMcpSession(context.sessionId);
      context.secret = { token: current?.token, link: current?.link };
      context.token = current?.token;
    }
    replies.push(await answer(message, context));
  }
  const sessionHeader: Record<string, string> = sessionId && session ? { "Mcp-Session-Id": sessionId } : {};
  if (!replies.length) return new Response(null, { status: 202, headers: { ...headers, ...sessionHeader } });
  return Response.json(Array.isArray(parsed) ? replies : replies[0], { headers: { ...headers, ...sessionHeader } });
}

/** No server-initiated stream is offered. */
export function GET() {
  return new Response(null, { status: 405, headers: { ...headers, Allow: "POST, DELETE" } });
}

export function DELETE(request: Request) {
  const sessionId = request.headers.get("mcp-session-id");
  if (sessionId && readMcpSession(sessionId)) deleteMcpSession(sessionId);
  return new Response(null, { status: 204, headers });
}
