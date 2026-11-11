import crypto from "node:crypto";
import type { AppConfig } from "./config.ts";

export interface SessionUser {
  sub: string;
  email: string;
  name: string;
  username: string;
  csrfToken: string;
  iat: number;
  exp: number;
}

interface OAuthStatePayload {
  state: string;
  codeVerifier: string;
  returnTo: string;
  exp: number;
}

const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 hours
const OAUTH_STATE_TTL_SECONDS = 10 * 60; // 10 minutes

export const POSIX_USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

export const RESERVED_USERNAMES = new Set([
  "root",
  "daemon",
  "bin",
  "sys",
  "sync",
  "games",
  "man",
  "lp",
  "mail",
  "news",
  "uucp",
  "proxy",
  "www-data",
  "backup",
  "list",
  "irc",
  "gnats",
  "nobody",
  "_apt",
  "systemd-network",
  "systemd-resolve",
  "systemd-timesync",
  "messagebus",
  "sshd",
  "xrdp",
  "sesman",
  "polkitd",
  "caddy",
  "sudo",
  "admin",
  "administrator",
  "docker",
  "postgres",
  "mysql",
  "redis",
  "ubuntu",
  "debian",
]);

export function isHttpsRequest(req: Request, config: AppConfig): boolean {
  if (config.publicBaseUrl?.startsWith("https://")) {
    return true;
  }
  if (config.trustProxy) {
    const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    if (proto === "https") return true;
  }
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function getExternalOrigin(req: Request, config: AppConfig): string {
  if (config.publicBaseUrl) {
    return config.publicBaseUrl;
  }
  const url = new URL(req.url);
  if (config.trustProxy) {
    const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
    const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host") || url.host;
    return `${proto}://${host}`;
  }
  return url.origin;
}

export function sessionCookieName(secure: boolean): string {
  return secure ? "__Host-apigee_session" : "apigee_session";
}

export function oauthStateCookieName(secure: boolean): string {
  return secure ? "__Host-apigee_oauth" : "apigee_oauth";
}

function hmacSign(data: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(data).digest("base64url");
}

export function signToken(payload: object, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = hmacSign(encoded, secret);
  return `${encoded}.${sig}`;
}

export function verifyToken<T>(token: string | undefined | null, secret: string): T | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expectedSig = hmacSign(encoded, secret);

  const sigBuf = Buffer.from(sig, "utf8");
  const expBuf = Buffer.from(expectedSig, "utf8");
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as T & { exp?: number };
    if (typeof parsed.exp === "number" && Date.now() / 1000 >= parsed.exp) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function parseCookies(cookieHeader: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function serializeCookie(
  name: string,
  value: string,
  opts: { maxAge: number; secure: boolean; httpOnly?: boolean; sameSite?: "Lax" | "Strict" }
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", `Max-Age=${opts.maxAge}`];
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  parts.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function deriveLinuxUsername(email: string, allowedDomain: string): string {
  const normalized = email.trim().toLowerCase();
  const atIndex = normalized.lastIndexOf("@");
  if (atIndex <= 0) {
    throw new Error("Invalid email address");
  }
  const localPart = normalized.slice(0, atIndex);
  const domain = normalized.slice(atIndex + 1);

  if (domain !== allowedDomain.toLowerCase()) {
    throw new Error(`Only @${allowedDomain} accounts are permitted`);
  }

  if (!/^[a-z0-9._-]+$/.test(localPart)) {
    throw new Error("Email local-part contains unsupported characters for VM username");
  }

  // Normalize dots to underscores and trim to POSIX 32-char limit
  let candidate = localPart.replace(/\./g, "_").replace(/^[^a-z_]+/, "");
  if (!candidate) {
    candidate = `u_${localPart.replace(/[^a-z0-9_-]/g, "")}`;
  }
  candidate = candidate.slice(0, 32);

  if (!POSIX_USERNAME_RE.test(candidate)) {
    throw new Error("Derived VM username does not satisfy POSIX naming rules");
  }
  if (RESERVED_USERNAMES.has(candidate)) {
    throw new Error(`Username '${candidate}' is reserved on this system`);
  }

  return candidate;
}

export function getSessionFromRequest(req: Request, config: AppConfig): SessionUser | null {
  const cookies = parseCookies(req.headers.get("cookie"));
  const raw = cookies["__Host-apigee_session"] ?? cookies["apigee_session"];
  const session = verifyToken<SessionUser>(raw, config.sessionSecret);
  if (!session) return null;
  if (!session.email?.toLowerCase().endsWith(`@${config.allowedGoogleDomain}`)) {
    return null;
  }
  if (!POSIX_USERNAME_RE.test(session.username) || RESERVED_USERNAMES.has(session.username)) {
    return null;
  }
  return session;
}

export function createSessionCookieHeader(
  user: { sub: string; email: string; name: string; username: string },
  req: Request,
  config: AppConfig
): { cookie: string; session: SessionUser } {
  const now = Math.floor(Date.now() / 1000);
  const session: SessionUser = {
    sub: user.sub,
    email: user.email.toLowerCase(),
    name: user.name,
    username: user.username,
    csrfToken: crypto.randomBytes(24).toString("base64url"),
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  };
  const secure = isHttpsRequest(req, config);
  const token = signToken(session, config.sessionSecret);
  const cookie = serializeCookie(sessionCookieName(secure), token, {
    maxAge: SESSION_TTL_SECONDS,
    secure,
    httpOnly: true,
    sameSite: "Lax",
  });
  return { cookie, session };
}

export function clearSessionCookieHeaders(req: Request, config: AppConfig): string[] {
  const secure = isHttpsRequest(req, config);
  const headers = [
    serializeCookie(sessionCookieName(secure), "", { maxAge: 0, secure, httpOnly: true, sameSite: "Lax" }),
  ];
  if (secure) {
    headers.push(serializeCookie("apigee_session", "", { maxAge: 0, secure: false, httpOnly: true, sameSite: "Lax" }));
  }
  return headers;
}

function sanitizeReturnTo(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) {
    return "/";
  }
  return raw;
}

export function buildGoogleAuthStart(req: Request, config: AppConfig): Response {
  if (!config.googleClientId || !config.googleClientSecret) {
    return Response.redirect(`${getExternalOrigin(req, config)}/?auth_error=oauth_not_configured`, 302);
  }

  const reqUrl = new URL(req.url);
  const returnTo = sanitizeReturnTo(reqUrl.searchParams.get("return_to"));

  const state = crypto.randomBytes(24).toString("base64url");
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

  const origin = getExternalOrigin(req, config);
  const redirectUri = `${origin}/api/auth/google/callback`;
  const secure = isHttpsRequest(req, config);

  const statePayload: OAuthStatePayload = {
    state,
    codeVerifier,
    returnTo,
    exp: Math.floor(Date.now() / 1000) + OAUTH_STATE_TTL_SECONDS,
  };

  const stateCookie = serializeCookie(
    oauthStateCookieName(secure),
    signToken(statePayload, config.sessionSecret),
    {
      maxAge: OAUTH_STATE_TTL_SECONDS,
      secure,
      httpOnly: true,
      sameSite: "Lax",
    }
  );

  const googleUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  googleUrl.searchParams.set("client_id", config.googleClientId);
  googleUrl.searchParams.set("redirect_uri", redirectUri);
  googleUrl.searchParams.set("response_type", "code");
  googleUrl.searchParams.set("scope", "openid email profile");
  googleUrl.searchParams.set("state", state);
  googleUrl.searchParams.set("code_challenge", codeChallenge);
  googleUrl.searchParams.set("code_challenge_method", "S256");
  googleUrl.searchParams.set("hd", config.allowedGoogleDomain);
  googleUrl.searchParams.set("prompt", "select_account");

  return new Response(null, {
    status: 302,
    headers: {
      Location: googleUrl.toString(),
      "Set-Cookie": stateCookie,
      "Cache-Control": "no-store",
    },
  });
}

interface GoogleIdTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  email?: string;
  email_verified?: boolean;
  hd?: string;
  name?: string;
  exp: number;
}

function decodeJwtPayload(jwt: string): GoogleIdTokenClaims {
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed ID token");
  }
  return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as GoogleIdTokenClaims;
}

export async function handleGoogleAuthCallback(req: Request, config: AppConfig): Promise<Response> {
  const origin = getExternalOrigin(req, config);
  const secure = isHttpsRequest(req, config);
  const clearOauthCookie = serializeCookie(oauthStateCookieName(secure), "", {
    maxAge: 0,
    secure,
    httpOnly: true,
    sameSite: "Lax",
  });

  const redirectWithError = (code: string) =>
    new Response(null, {
      status: 302,
      headers: {
        Location: `${origin}/?auth_error=${encodeURIComponent(code)}`,
        "Set-Cookie": clearOauthCookie,
        "Cache-Control": "no-store",
      },
    });

  const url = new URL(req.url);
  if (url.searchParams.get("error")) {
    return redirectWithError("access_denied");
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return redirectWithError("invalid_callback");
  }

  const cookies = parseCookies(req.headers.get("cookie"));
  const rawStateToken = cookies["__Host-apigee_oauth"] ?? cookies["apigee_oauth"];
  const savedState = verifyToken<OAuthStatePayload>(rawStateToken, config.sessionSecret);
  if (!savedState) {
    return redirectWithError("expired_state");
  }

  const a = Buffer.from(state, "utf8");
  const b = Buffer.from(savedState.state, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return redirectWithError("state_mismatch");
  }

  const redirectUri = `${origin}/api/auth/google/callback`;
  const body = new URLSearchParams({
    code,
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: savedState.codeVerifier,
  });

  let tokenJson: { id_token?: string };
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!tokenRes.ok) {
      return redirectWithError("token_exchange_failed");
    }
    tokenJson = (await tokenRes.json()) as { id_token?: string };
  } catch {
    return redirectWithError("token_exchange_failed");
  }

  if (!tokenJson.id_token) {
    return redirectWithError("missing_id_token");
  }

  let claims: GoogleIdTokenClaims;
  try {
    claims = decodeJwtPayload(tokenJson.id_token);
  } catch {
    return redirectWithError("invalid_id_token");
  }

  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") {
    return redirectWithError("invalid_issuer");
  }
  if (claims.aud !== config.googleClientId) {
    return redirectWithError("invalid_audience");
  }
  if (claims.exp <= now) {
    return redirectWithError("expired_token");
  }
  if (claims.email_verified !== true || !claims.email) {
    return redirectWithError("unverified_email");
  }
  if (
    claims.hd?.toLowerCase() !== config.allowedGoogleDomain ||
    !claims.email.toLowerCase().endsWith(`@${config.allowedGoogleDomain}`)
  ) {
    return redirectWithError("domain_not_allowed");
  }

  let username: string;
  try {
    username = deriveLinuxUsername(claims.email, config.allowedGoogleDomain);
  } catch {
    return redirectWithError("invalid_username");
  }

  const { cookie: sessionCookie } = createSessionCookieHeader(
    {
      sub: claims.sub,
      email: claims.email.toLowerCase(),
      name: claims.name || username,
      username,
    },
    req,
    config
  );

  const headers = new Headers();
  headers.set("Location", `${origin}${sanitizeReturnTo(savedState.returnTo)}`);
  headers.set("Cache-Control", "no-store");
  headers.append("Set-Cookie", clearOauthCookie);
  headers.append("Set-Cookie", sessionCookie);

  return new Response(null, { status: 302, headers });
}
