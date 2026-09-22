import { createHash, createPrivateKey, createPublicKey, sign, verify, type JsonWebKey } from "node:crypto";
import { readFileSync } from "node:fs";

export type ProviderId = "google" | "apple" | "linkedin";
export type Provider = {
  id: ProviderId; label: string; authorize: string; token: string; userinfo?: string; jwks: string; issuers: string[];
  scope: string; pkce: boolean; requireNonce: boolean; formPost: boolean; clientId: string; clientSecret: () => string;
};
export type Claims = { sub: string; email?: string; email_verified?: boolean | string; name?: string; nonce?: string;
  iss: string; aud: string | string[]; exp: number; iat: number };

const env = (name: string) => process.env[name]?.trim() || undefined;

function applePrivateKey() {
  const file = env("SPHR_APPLE_PRIVATE_KEY_FILE");
  return file ? readFileSync(file, "utf8") : env("SPHR_APPLE_PRIVATE_KEY")?.replace(/\\n/g, "\n");
}

/** Apple's client secret is a short-lived ES256 JWT signed with the Sign in with Apple key. */
export function appleClientSecret(clientId: string, teamId: string, keyId: string, pem: string, issuedAt = Math.floor(Date.now() / 1000)) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode({ alg: "ES256", kid: keyId, typ: "JWT" })}.${encode({ iss: teamId, iat: issuedAt, exp: issuedAt + 300, aud: "https://appleid.apple.com", sub: clientId })}`;
  const signature = sign("sha256", Buffer.from(body), { key: createPrivateKey(pem), dsaEncoding: "ieee-p1363" });
  return `${body}.${signature.toString("base64url")}`;
}

// Endpoint overrides exist only for local end-to-end tests against a fake identity provider.
function endpoints(id: ProviderId, defaults: Pick<Provider, "authorize" | "token" | "jwks" | "issuers"> & { userinfo?: string }) {
  const base = process.env.NODE_ENV !== "production" ? env("SPHR_OAUTH_TEST_BASE") : undefined;
  if (!base) return defaults;
  return { authorize: `${base}/${id}/authorize`, token: `${base}/${id}/token`, jwks: `${base}/${id}/jwks`, issuers: [`${base}/${id}`],
    ...(defaults.userinfo ? { userinfo: `${base}/${id}/userinfo` } : {}) };
}

export function oauthProvider(id: string): Provider | undefined {
  if (id === "google") {
    const clientId = env("SPHR_GOOGLE_CLIENT_ID"), secret = env("SPHR_GOOGLE_CLIENT_SECRET");
    if (!clientId || !secret) return undefined;
    return { id, label: "Google", scope: "openid email profile", pkce: true, requireNonce: true, formPost: false, clientId, clientSecret: () => secret,
      ...endpoints(id, { authorize: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token",
        jwks: "https://www.googleapis.com/oauth2/v3/certs", issuers: ["https://accounts.google.com", "accounts.google.com"] }) };
  }
  if (id === "apple") {
    const clientId = env("SPHR_APPLE_CLIENT_ID"), team = env("SPHR_APPLE_TEAM_ID"), key = env("SPHR_APPLE_KEY_ID");
    if (!clientId || !team || !key || !(env("SPHR_APPLE_PRIVATE_KEY") || env("SPHR_APPLE_PRIVATE_KEY_FILE"))) return undefined;
    return { id, label: "Apple", scope: "name email", pkce: false, requireNonce: true, formPost: true, clientId,
      clientSecret: () => appleClientSecret(clientId, team, key, applePrivateKey()!),
      ...endpoints(id, { authorize: "https://appleid.apple.com/auth/authorize", token: "https://appleid.apple.com/auth/token",
        jwks: "https://appleid.apple.com/auth/keys", issuers: ["https://appleid.apple.com"] }) };
  }
  if (id === "linkedin") {
    const clientId = env("SPHR_LINKEDIN_CLIENT_ID"), secret = env("SPHR_LINKEDIN_CLIENT_SECRET");
    if (!clientId || !secret) return undefined;
    return { id, label: "LinkedIn", scope: "openid profile email", pkce: false, requireNonce: false, formPost: false, clientId, clientSecret: () => secret,
      ...endpoints(id, { authorize: "https://www.linkedin.com/oauth/v2/authorization", token: "https://www.linkedin.com/oauth/v2/accessToken",
        userinfo: "https://api.linkedin.com/v2/userinfo", jwks: "https://www.linkedin.com/oauth/openid/jwks", issuers: ["https://www.linkedin.com"] }) };
  }
  return undefined;
}

export function enabledProviders() {
  return (["google", "apple", "linkedin"] as const).filter(id => oauthProvider(id)).map(id => ({ id, label: oauthProvider(id)!.label }));
}

export function redirectUri(provider: Provider, origin: string) {
  return `${origin}/api/auth/${provider.id}/callback`;
}

export function authorizationUrl(provider: Provider, origin: string, check: { state: string; verifier: string; nonce: string }) {
  const url = new URL(provider.authorize);
  url.search = new URLSearchParams({ response_type: "code", client_id: provider.clientId, redirect_uri: redirectUri(provider, origin),
    scope: provider.scope, state: check.state, nonce: check.nonce,
    ...(provider.pkce ? { code_challenge: createHash("sha256").update(check.verifier).digest("base64url"), code_challenge_method: "S256" } : {}),
    ...(provider.formPost ? { response_mode: "form_post" } : {}),
    ...(provider.id === "google" ? { prompt: "select_account" } : {}) }).toString();
  return url.href;
}

type KeySet = { keys: (JsonWebKey & { kid?: string })[] };
const keySets = new Map<string, { keys: KeySet["keys"]; expires: number }>();

async function signingKey(url: string, kid: string) {
  for (const refresh of [false, true]) {
    let cached = keySets.get(url);
    if (refresh || !cached || cached.expires < Date.now()) {
      const response = await fetch(url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`Signing keys unavailable: HTTP ${response.status}`);
      const set = await response.json() as KeySet;
      if (!Array.isArray(set.keys)) throw new Error("Invalid signing key set.");
      cached = { keys: set.keys, expires: Date.now() + 60 * 60 * 1000 };
      keySets.set(url, cached);
    }
    const key = cached.keys.find(item => item.kid === kid && item.kty === "RSA");
    if (key) return createPublicKey({ key, format: "jwk" });
  }
  throw new Error("Unknown ID token signing key.");
}

/** Verifies an RS256 ID token's signature, issuer, audience, lifetime and nonce. */
export async function verifyIdToken(provider: Provider, token: string, nonce: string, now = Date.now()): Promise<Claims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed ID token.");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("Unsupported ID token.");
  const key = await signingKey(provider.jwks, header.kid);
  if (!verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"))) throw new Error("Invalid ID token signature.");
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Claims;
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!provider.issuers.includes(claims.iss)) throw new Error("Unexpected ID token issuer.");
  if (!audience.includes(provider.clientId)) throw new Error("ID token was issued to another application.");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < now - 60000) throw new Error("Expired ID token.");
  if (typeof claims.iat !== "number" || claims.iat * 1000 > now + 5 * 60000) throw new Error("ID token issued in the future.");
  if ((provider.requireNonce || claims.nonce !== undefined) && claims.nonce !== nonce) throw new Error("ID token nonce mismatch.");
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255) throw new Error("Missing ID token subject.");
  return claims;
}

export async function exchangeCode(provider: Provider, origin: string, code: string, check: { verifier: string; nonce: string }) {
  if (!code || code.length > 2048) throw new Error("Missing authorization code.");
  const response = await fetch(provider.token, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri(provider, origin),
      client_id: provider.clientId, client_secret: provider.clientSecret(), ...(provider.pkce ? { code_verifier: check.verifier } : {}) }) });
  const tokens = await response.json().catch(() => ({})) as { id_token?: string; access_token?: string };
  if (!response.ok || typeof tokens.id_token !== "string") throw new Error(`Token exchange failed: HTTP ${response.status}`);
  const claims = await verifyIdToken(provider, tokens.id_token, check.nonce);
  if (!claims.email && provider.userinfo && tokens.access_token) {
    const info = await fetch(provider.userinfo, { headers: { Authorization: `Bearer ${tokens.access_token}` }, redirect: "error", signal: AbortSignal.timeout(10000) });
    const profile = info.ok ? await info.json() as Partial<Claims> : {};
    if (profile.sub === claims.sub) Object.assign(claims, { email: profile.email, email_verified: profile.email_verified, name: claims.name ?? profile.name });
  }
  return claims;
}

/** Apple sends the name once, in the first form post, outside the signed token. */
export function appleName(user: unknown) {
  if (typeof user !== "string" || user.length > 2000) return null;
  try {
    const name = JSON.parse(user)?.name;
    return [name?.firstName, name?.lastName].filter(part => typeof part === "string").join(" ").trim() || null;
  } catch { return null; }
}
