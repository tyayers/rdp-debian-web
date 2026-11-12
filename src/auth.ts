import crypto from "node:crypto";
import type { AppConfig } from "./config.ts";

export type AuthSource = "iap" | "query" | "cookie";

export interface SessionUser {
  email: string;
  username: string;
  csrfToken: string;
  iat: number;
  exp: number;
}

const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 hours

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
    const proto =
      req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
    const host =
      req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
      req.headers.get("host") ||
      url.host;
    return `${proto}://${host}`;
  }
  return url.origin;
}

export function sessionCookieName(secure: boolean): string {
  return secure ? "__Host-apigee_session" : "apigee_session";
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
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as T & {
      exp?: number;
    };
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

/**
 * Parses a GCP IAP email header (`accounts.google.com:alice@example.com`), email (`test@example.com`),
 * or bare username (`test`) into a normalized `{ email, username }` pair.
 */
export function parseUserIdentity(rawInput: string): { email: string; username: string } {
  // Strip optional IAP issuer prefix such as "accounts.google.com:"
  const stripped = rawInput.trim().replace(/^[^:@\s]+:/, "").trim().toLowerCase();
  if (!stripped || stripped.length > 254) {
    throw new Error("Invalid user identifier");
  }

  let localPart = stripped;
  let email = stripped;

  const atIndex = stripped.lastIndexOf("@");
  if (atIndex !== -1) {
    localPart = stripped.slice(0, atIndex);
    const domain = stripped.slice(atIndex + 1);
    if (!localPart || !domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
      throw new Error("Invalid email address");
    }
  }

  if (!/^[a-z0-9._+-]+$/.test(localPart)) {
    throw new Error("Username contains unsupported characters");
  }

  // Normalize dots/pluses to underscores and conform to 32-char POSIX username rules
  let candidate = localPart.replace(/[.+]/g, "_").replace(/^[^a-z_]+/, "");
  if (!candidate) {
    candidate = `u_${localPart.replace(/[^a-z0-9_-]/g, "")}`;
  }
  candidate = candidate.slice(0, 32);

  if (!POSIX_USERNAME_RE.test(candidate)) {
    throw new Error("Derived Linux username does not satisfy POSIX naming rules");
  }
  if (RESERVED_USERNAMES.has(candidate)) {
    throw new Error(`Username '${candidate}' is reserved on this system`);
  }

  return { email, username: candidate };
}

export function deriveLinuxUsername(emailOrUser: string): string {
  return parseUserIdentity(emailOrUser).username;
}

export function getCookieSession(req: Request, config: AppConfig): SessionUser | null {
  const cookies = parseCookies(req.headers.get("cookie"));
  const raw = cookies["__Host-apigee_session"] ?? cookies["apigee_session"];
  const session = verifyToken<SessionUser>(raw, config.sessionSecret);
  if (!session) return null;
  if (!POSIX_USERNAME_RE.test(session.username) || RESERVED_USERNAMES.has(session.username)) {
    return null;
  }
  return session;
}

export function createSessionCookieHeader(
  identity: { email: string; username: string },
  req: Request,
  config: AppConfig
): { cookie: string; session: SessionUser } {
  const now = Math.floor(Date.now() / 1000);
  const session: SessionUser = {
    email: identity.email.toLowerCase(),
    username: identity.username,
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
    serializeCookie(sessionCookieName(secure), "", {
      maxAge: 0,
      secure,
      httpOnly: true,
      sameSite: "Lax",
    }),
  ];
  if (secure) {
    headers.push(
      serializeCookie("apigee_session", "", {
        maxAge: 0,
        secure: false,
        httpOnly: true,
        sameSite: "Lax",
      })
    );
  }
  return headers;
}

/**
 * Resolves the active user from:
 *   1. `?user=test@example.com` URL query parameter (for direct testing without IAP)
 *   2. GCP IAP header (`X-Goog-Authenticated-User-Email: accounts.google.com:user@example.com`)
 *   3. Signed session cookie (set on initial load so `/api/rdp/ws` and `/desktop` inherit it)
 */
export function resolveRequestIdentity(
  req: Request,
  config: AppConfig
): { session: SessionUser; setCookie?: string; source: AuthSource } | { error: string } | null {
  const url = new URL(req.url);
  const existingCookie = getCookieSession(req, config);

  // 1. Explicit URL parameter (?user=test@example.com)
  const queryUser = url.searchParams.get("user")?.trim();
  if (queryUser) {
    try {
      const parsed = parseUserIdentity(queryUser);
      if (
        existingCookie &&
        existingCookie.username === parsed.username &&
        existingCookie.email === parsed.email
      ) {
        return { session: existingCookie, source: "query" };
      }
      const { cookie, session } = createSessionCookieHeader(parsed, req, config);
      return { session, setCookie: cookie, source: "query" };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Invalid ?user= parameter" };
    }
  }

  // 2. GCP IAP authenticated email header
  const iapHeader = req.headers.get(config.iapEmailHeader)?.trim();
  if (iapHeader) {
    try {
      const parsed = parseUserIdentity(iapHeader);
      if (
        existingCookie &&
        existingCookie.username === parsed.username &&
        existingCookie.email === parsed.email
      ) {
        return { session: existingCookie, source: "iap" };
      }
      const { cookie, session } = createSessionCookieHeader(parsed, req, config);
      return { session, setCookie: cookie, source: "iap" };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Invalid IAP user header" };
    }
  }

  // 3. Previously established session cookie (e.g. WebSocket upgrade or /desktop tab)
  if (existingCookie) {
    return { session: existingCookie, source: "cookie" };
  }

  return null;
}
