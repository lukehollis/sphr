import { collect, corsHeaders } from "@/lib/server/analytics";

// Where pages send their analytics (see lib/server/analytics.ts), under a name blocklists leave
// alone. /api/analytics answers the same way for pages loaded before the rename.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return collect(request);
}

export async function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}
