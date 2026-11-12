import crypto from "node:crypto";
import path from "node:path";
import { loadConfig, type AppConfig } from "./config.ts";
import {
  buildGoogleAuthStart,
  clearSessionCookieHeaders,
  createSessionCookieHeader,
  deriveLinuxUsername,
  getExternalOrigin,
  getSessionFromRequest,
  handleGoogleAuthCallback,
  type SessionUser,
} from "./auth.ts";
import { VmUserManager } from "./vm-users.ts";
import { EMBEDDED_PUBLIC_FILES } from "./embedded-assets.ts";
import {
  cleanupSockets,
  createRdpWsContext,
  handleRdpWsMessage,
  rdpLog,
  type RdpWsContext,
} from "./rdp-proxy.ts";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export interface DemoCatalogItem {
  id: string;
  title: string;
  summary: string;
  kind: "workstation" | "scenario";
  status: "ready" | "coming_soon";
  docUrl?: string;
}

const DEMO_CATALOG: DemoCatalogItem[] = [
  {
    id: "vm-desktop",
    title: "VM Remote Desktop",
    summary: "Interactive Debian workstation session over xrdp for running Apigee AI tools and local labs.",
    kind: "workstation",
    status: "ready",
  },
];

function applySecurityHeaders(headers: Headers, cspNonce?: string): void {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "SAMEORIGIN");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set(
    "Permissions-Policy",
    "camera=(), geolocation=(), microphone=(), focus-without-user-activation=()"
  );
  headers.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Vary", "Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site");

  const scriptSrc = cspNonce
    ? `'self' 'nonce-${cspNonce}' 'wasm-unsafe-eval'`
    : `'self' 'wasm-unsafe-eval'`;

  headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      `script-src ${scriptSrc}`,
      "style-src 'self'",
      "img-src 'self' data: blob:",
      "connect-src 'self' ws: wss:",
      "frame-ancestors 'self'",
      "base-uri 'none'",
      "form-action 'self' https://accounts.google.com",
    ].join("; ")
  );
}

function jsonResponse(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  applySecurityHeaders(headers);
  return new Response(JSON.stringify(data), { status, headers });
}

function isAllowedFetchMetadata(req: Request, pathname: string): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (!site) return true; // Non-browser or legacy client

  if (site === "same-origin" || site === "none") {
    return true;
  }

  // Allow top-level OAuth redirect returning from accounts.google.com
  const mode = req.headers.get("sec-fetch-mode");
  const dest = req.headers.get("sec-fetch-dest");
  if (
    req.method === "GET" &&
    mode === "navigate" &&
    dest !== "object" &&
    dest !== "embed" &&
    (pathname === "/" || pathname === "/desktop" || pathname === "/api/auth/google/callback")
  ) {
    return true;
  }

  return false;
}

function verifyCsrf(req: Request, session: SessionUser): boolean {
  const provided = req.headers.get("x-csrf-token") ?? "";
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(session.csrfToken, "utf8");
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyWsOrigin(req: Request, config: AppConfig): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const expected = getExternalOrigin(req, config);
  try {
    return new URL(origin).host === new URL(expected).host;
  } catch {
    return false;
  }
}

export function createAppServer(customConfig?: Partial<AppConfig>) {
  const config: AppConfig = { ...loadConfig(), ...customConfig };
  const vmUsers = new VmUserManager(config);

  const server = Bun.serve<RdpWsContext>({
    hostname: config.host,
    port: config.port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      if (!isAllowedFetchMetadata(req, pathname)) {
        return jsonResponse({ error: "Cross-site request blocked" }, 403);
      }

      // WebSocket endpoint for browser IronRDP WASM <-> local xrdp
      if (pathname === "/api/rdp/ws") {
        if (!verifyWsOrigin(req, config)) {
          console.warn(
            `${new Date().toISOString()} [rdp] Blocked WebSocket upgrade: origin mismatch (origin=${req.headers.get("origin")}, expected=${getExternalOrigin(req, config)})`
          );
          return jsonResponse({ error: "Invalid WebSocket origin" }, 403);
        }
        const session = getSessionFromRequest(req, config);
        if (!session) {
          console.warn(`${new Date().toISOString()} [rdp] Blocked WebSocket upgrade: unauthenticated request`);
          return jsonResponse({ error: "Authentication required" }, 401);
        }
        const status = await vmUsers.getStatus(session.username);
        if (!status.provisioned) {
          console.warn(
            `${new Date().toISOString()} [rdp] Blocked WebSocket upgrade for '${session.username}': local VM user not provisioned (existsOnSystem=${status.existsOnSystem}, mode=${config.vmUserMode})`
          );
          return jsonResponse({ error: "Local VM account must be initialized first" }, 403);
        }

        const wsCtx = createRdpWsContext(session, config);
        const upgraded = srv.upgrade(req, { data: wsCtx });
        if (upgraded) {
          rdpLog(
            wsCtx,
            `WebSocket upgraded (email=${session.email}, vmUserMode=${config.vmUserMode}, existsOnSystem=${status.existsOnSystem})`
          );
          return undefined;
        }
        return jsonResponse({ error: "WebSocket upgrade failed" }, 400);
      }

      // Health check
      if (pathname === "/api/health" && req.method === "GET") {
        return jsonResponse({ ok: true });
      }

      // Session & VM user status
      if (pathname === "/api/me" && req.method === "GET") {
        const session = getSessionFromRequest(req, config);
        const oauthConfigured = Boolean(config.googleClientId && config.googleClientSecret);

        if (!session) {
          return jsonResponse({
            authenticated: false,
            oauthConfigured,
            devAuthEnabled: config.allowDevAuth,
            allowedDomain: config.allowedGoogleDomain,
          });
        }

        try {
          const vmStatus = await vmUsers.getStatus(session.username);
          return jsonResponse({
            authenticated: true,
            oauthConfigured,
            devAuthEnabled: config.allowDevAuth,
            allowedDomain: config.allowedGoogleDomain,
            csrfToken: session.csrfToken,
            user: {
              email: session.email,
              name: session.name,
              username: session.username,
            },
            vmUser: vmStatus,
            vmUserMode: config.vmUserMode,
            demos: DEMO_CATALOG,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Failed to inspect VM account";
          return jsonResponse({ error: message }, 500);
        }
      }

      // Google OAuth start & callback
      if (pathname === "/api/auth/google/login" && req.method === "GET") {
        const resp = buildGoogleAuthStart(req, config);
        applySecurityHeaders(resp.headers);
        return resp;
      }

      if (pathname === "/api/auth/google/callback" && req.method === "GET") {
        const resp = await handleGoogleAuthCallback(req, config);
        applySecurityHeaders(resp.headers);
        return resp;
      }

      // Opt-in local dev login (strictly disabled unless ALLOW_DEV_AUTH=true)
      if (pathname === "/api/auth/dev-login" && req.method === "POST") {
        if (!config.allowDevAuth) {
          return jsonResponse({ error: "Not found" }, 404);
        }
        let body: { email?: string; name?: string };
        try {
          body = (await req.json()) as { email?: string; name?: string };
        } catch {
          return jsonResponse({ error: "Invalid JSON body" }, 400);
        }

        const email = (body.email ?? "").trim().toLowerCase();
        let username: string;
        try {
          username = deriveLinuxUsername(email, config.allowedGoogleDomain);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Invalid email";
          return jsonResponse({ error: msg }, 403);
        }

        const { cookie } = createSessionCookieHeader(
          {
            sub: `dev:${email}`,
            email,
            name: body.name?.trim() || username,
            username,
          },
          req,
          config
        );

        return jsonResponse({ ok: true }, 200, { "Set-Cookie": cookie });
      }

      // Logout
      if (pathname === "/api/auth/logout" && req.method === "POST") {
        const session = getSessionFromRequest(req, config);
        if (session && !verifyCsrf(req, session)) {
          return jsonResponse({ error: "Invalid CSRF token" }, 403);
        }
        const headers = new Headers();
        for (const cookie of clearSessionCookieHeaders(req, config)) {
          headers.append("Set-Cookie", cookie);
        }
        headers.set("Clear-Site-Data", '"cookies", "storage"');
        return jsonResponse({ ok: true }, 200, headers);
      }

      // Create VM user (first login) or change VM user password
      if (pathname === "/api/vm-user/password" && req.method === "POST") {
        const session = getSessionFromRequest(req, config);
        if (!session) {
          return jsonResponse({ error: "Authentication required" }, 401);
        }
        if (!verifyCsrf(req, session)) {
          return jsonResponse({ error: "Invalid CSRF token" }, 403);
        }

        let body: { password?: string };
        try {
          body = (await req.json()) as { password?: string };
        } catch {
          return jsonResponse({ error: "Invalid JSON body" }, 400);
        }

        try {
          const result = await vmUsers.setupOrUpdatePassword(
            session.username,
            session.email,
            body.password ?? ""
          );
          return jsonResponse({
            ok: true,
            created: result.created,
            vmUser: result.status,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Failed to configure VM user";
          console.error(
            `${new Date().toISOString()} [vm-users] Failed configuring '${session.username}' (mode=${config.vmUserMode}): ${msg}`
          );
          return jsonResponse({ error: msg }, 400);
        }
      }

      if (pathname.startsWith("/api/")) {
        return jsonResponse({ error: "Not found" }, 404);
      }

      // Serve index.html for "/" and "/desktop" (standalone full-tab desktop mode)
      if (req.method === "GET" || req.method === "HEAD") {
        if (pathname === "/" || pathname === "/desktop") {
          const nonce = crypto.randomBytes(16).toString("base64");
          const diskIndex = Bun.file(path.join(config.publicDir, "index.html"));
          const indexFile = (await diskIndex.exists())
            ? diskIndex
            : Bun.file(EMBEDDED_PUBLIC_FILES["/index.html"]!.filePath);
          const htmlTemplate = await indexFile.text();
          const html = htmlTemplate.replaceAll("{{CSP_NONCE}}", nonce);
          const headers = new Headers({
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache",
          });
          applySecurityHeaders(headers, nonce);
          return new Response(req.method === "HEAD" ? null : html, { status: 200, headers });
        }

        // Safe static asset resolution inside publicDir (with embedded binary fallback)
        const safeRel = path.posix.normalize(pathname).replace(/^\/+/, "");
        const resolved = path.resolve(config.publicDir, safeRel);
        if (
          resolved.startsWith(config.publicDir + path.sep) &&
          !safeRel.includes("..")
        ) {
          const file = Bun.file(resolved);
          if (await file.exists()) {
            const ext = path.extname(resolved).toLowerCase();
            const headers = new Headers({
              "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
              "Cache-Control": ext === ".wasm" ? "public, max-age=3600" : "no-cache",
            });
            applySecurityHeaders(headers);
            return new Response(req.method === "HEAD" ? null : file, { status: 200, headers });
          }
        }

        const embedded = EMBEDDED_PUBLIC_FILES[`/${safeRel}`];
        if (embedded) {
          const file = Bun.file(embedded.filePath);
          const headers = new Headers({
            "Content-Type": embedded.contentType,
            "Cache-Control": safeRel.endsWith(".wasm") ? "public, max-age=3600" : "no-cache",
          });
          applySecurityHeaders(headers);
          return new Response(req.method === "HEAD" ? null : file, { status: 200, headers });
        }
      }

      return jsonResponse({ error: "Not found" }, 404);
    },

    websocket: {
      maxPayloadLength: 16 * 1024 * 1024,
      idleTimeout: 120,
      sendPings: true,
      message(ws, message) {
        handleRdpWsMessage(ws, message, config, vmUsers);
      },
      close(ws, code, reason) {
        const elapsed = Date.now() - ws.data.openedAt;
        rdpLog(
          ws.data,
          `Browser WebSocket closed (code=${code}, reason=${reason || "none"}, duration=${elapsed}ms, tx=${ws.data.txBytes}B, rx=${ws.data.rxBytes}B)`
        );
        cleanupSockets(ws.data);
      },
    },
  });

  return { server, config, vmUsers };
}

if (import.meta.main) {
  const { server, config, vmUsers } = createAppServer();
  console.log(
    `[Apigee AI Demos] Listening on http://${server.hostname}:${server.port} | xrdp=${config.rdpHost}:${config.rdpPort} | vmUserMode=${config.vmUserMode}${
      config.vmUserMode === "mock"
        ? " (WARNING: mock mode does NOT create real Linux users for xrdp!)"
        : ""
    }`
  );
  // Provision/update shared VM desktop apps once at server startup for all users
  void vmUsers.ensureSystemTools();
}
