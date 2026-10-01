import { collect, corsHeaders } from "@/lib/server/analytics";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return collect(request);
}

/** A sibling site may send events with fetch as well as sendBeacon. */
export async function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}
