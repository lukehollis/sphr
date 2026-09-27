import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { accessControlled, isScenePublic } from "./admin-store";
import { createUserSession, createUserToken, deleteUserSession, hostingActive, readCustomerSpace, spaceForScene, userFromSession,
  type CustomerSpace, type User } from "./accounts-store";
import { adminResponse, cookieOptions, isAdmin, readAdminBody, sameOrigin } from "./auth";
import { billingEnabled } from "./billing";
import { sendMail, type MailContent } from "./mail";
import { verificationEmail } from "./emails";
import { siteBrand } from "./brand";

/** Customer accounts are optional and build on the private-by-default access control. */
export function accountsEnabled() {
  return process.env.SPHR_ACCOUNTS === "1" && accessControlled();
}

export const sessionCookie = process.env.NODE_ENV === "production" ? "__Host-sphr-session" : "sphr-session";

export async function currentUser() {
  if (!accountsEnabled()) return undefined;
  return userFromSession((await cookies()).get(sessionCookie)?.value);
}

export async function startUserSession(userId: string) {
  const jar = await cookies();
  deleteUserSession(jar.get(sessionCookie)?.value);
  const session = createUserSession(userId);
  jar.set(sessionCookie, session.token, { ...cookieOptions, maxAge: session.maxAge });
}

export async function endUserSession() {
  const jar = await cookies();
  deleteUserSession(jar.get(sessionCookie)?.value);
  jar.set(sessionCookie, "", { ...cookieOptions, maxAge: 0 });
}

export function publicOrigin(request?: Request) {
  return new URL(process.env.SPHR_PUBLIC_URL || (request ? new URL(request.url).origin : "http://localhost:3002")).origin;
}

// Nginx overwrites X-Real-IP. The Node service only listens on loopback.
export function clientAddress(request: Request) {
  return request.headers.get("x-real-ip") || "local";
}

const returnPattern = /^\/(?:account(?:\/plan|\/spaces\/[a-f0-9]{12}(?:\/edit)?)?|s\/[a-f0-9]{12}(?:\/[a-z0-9-]+)?)?$/;
export function safeReturnPath(value: unknown, fallback = "/account") {
  return typeof value === "string" && returnPattern.test(value) ? value : fallback;
}

/** Rate-limit keys never store addresses or emails in plain text. */
export function attemptKey(scope: string, value: string) {
  return `account-${scope}:${createHash("sha256").update(value.toLowerCase()).digest("hex")}`;
}

/** Without billing configured, every customer space is hosted. */
export function spaceHosted(space: CustomerSpace) {
  return space.status !== "deleted" && (!billingEnabled() || hostingActive(space.userId));
}

export async function sendVerification(user: User, origin: string) {
  const token = createUserToken(user.id, "verify", 7 * 24 * 60 * 60 * 1000);
  await sendMail(user.email, verificationEmail(siteBrand(), origin, `${origin}/account/verify?token=${token}`));
}

export async function notifyOwner(user: User | undefined, content: MailContent) {
  if (!user) return;
  try { await sendMail(user.email, content); }
  catch (error) { console.error("Unable to send account email:", error instanceof Error ? error.message : error); }
}

export { adminResponse as accountResponse, readAdminBody as readAccountBody, sameOrigin };

/** Reads a same-origin JSON body and the signed-in customer, or returns the error response. */
export async function accountRequest(request: Request, maxBytes = 4096) {
  if (!accountsEnabled()) return { error: adminResponse({ error: "Accounts are unavailable." }, 404) } as const;
  const user = await currentUser();
  if (!user) return { error: adminResponse({ error: "Sign in to continue." }, 401) } as const;
  let body;
  try { body = await readAdminBody(request, maxBytes); } catch { return { error: adminResponse({ error: "Invalid request." }, 400) } as const; }
  return { user, body } as const;
}

export async function ownedSpace(id: string) {
  const user = await currentUser();
  const space = readCustomerSpace(id);
  return user && space && space.userId === user.id && space.status !== "deleted" ? { user, space } : undefined;
}

/**
 * Viewer access. Customer spaces stop being served when deleted or when billing
 * lapses; the operator can still open them to help.
 */
export async function sceneAccess(sceneId: string): Promise<"allowed" | "login" | "unavailable"> {
  const space = accountsEnabled() ? spaceForScene(sceneId) : undefined;
  if (await isAdmin()) return "allowed";
  if (space && !spaceHosted(space)) return "unavailable";
  if (isScenePublic(sceneId)) return "allowed";
  const user = await currentUser();
  if (space && user?.id === space.userId) return "allowed";
  // A signed-in customer who does not own the space would only be sent back here by sign-in.
  return user ? "unavailable" : "login";
}

/** Title, start view, thumbnail and visibility belong to the operator and the space's owner. */
export async function canManageScene(sceneId: string) {
  if (await isAdmin()) return true;
  const space = accountsEnabled() ? spaceForScene(sceneId) : undefined;
  return Boolean(space && space.status !== "deleted" && (await currentUser())?.id === space.userId);
}

export function loginPath(next: string) {
  return `${accountsEnabled() ? "/account/login" : "/admin/login"}?next=${encodeURIComponent(next)}`;
}
