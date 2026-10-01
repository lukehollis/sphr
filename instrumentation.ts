import type { Instrumentation } from "next";

// Server errors are recorded with the site's analytics and reported to the operator (see
// lib/server/error-report.ts). Loaded lazily: the state database is only for the Node.js runtime.
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { reportServerError } = await import("./lib/server/error-report");
    reportServerError(error, request, context);
  } catch (failure) { console.error("Unable to report a server error:", failure instanceof Error ? failure.message : failure); }
};
