import crypto from "node:crypto";
import path from "node:path";
import { loadConfig, type AppConfig } from "./config.ts";
import {
  clearSessionCookieHeaders,
  getExternalOrigin,
  resolveRequestIdentity,
  type SessionUser,
} from "./auth.ts";
import { VmUserManager, type SystemUserAdapter } from "./vm-users.ts";
import { EMBEDDED_PUBLIC_FILES } from "./embedded-assets.ts";
import {
  HostMetricsMonitor,
  RESOURCE_BUSY_MESSAGE,
  type HostMetricsProvider,
} from "./host-metrics.ts";
import {
  createRdpWsContext,
  handleRdpWsClose,
  handleRdpWsMessage,
  rdpLog,
  registerRdpWsOpen,
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
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
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
    summary:
      "Interactive Debian workstation session over xrdp for running Apigee AI tools and local labs.",
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
      "form-action 'self'",
    ].join("; ")
  );
}

const HEALTH_CHECK_PATHS = new Set([
  "/api/health",
  "/health",
  "/healthz",
  "/livez",
  "/readyz",
  "/ping",
  "/status",
]);

function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders?: HeadersInit,
  headOnly = false
): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  applySecurityHeaders(headers);
  return new Response(headOnly ? null : JSON.stringify(data), { status, headers });
}

function isAllowedFetchMetadata(req: Request, pathname: string): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (!site) return true;
  if (site === "same-origin" || site === "none") return true;

  // Allow top-level navigations (e.g. returning from GCP IAP login redirect or clicking external link)
  const mode = req.headers.get("sec-fetch-mode");
  const dest = req.headers.get("sec-fetch-dest");
  if (
    req.method === "GET" &&
    mode === "navigate" &&
    dest !== "object" &&
    dest !== "embed" &&
    (pathname === "/" || pathname === "/desktop")
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
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }

  const candidates = [getExternalOrigin(req, config), ...config.allowedOrigins];
  for (const candidate of candidates) {
    try {
      const candidateUrl = candidate.includes("://")
        ? new URL(candidate)
        : new URL(`${originUrl.protocol}//${candidate}`);
      if (originUrl.host === candidateUrl.host) {
        return true;
      }
    } catch {
      // Ignore malformed candidate
    }
  }
  return false;
}

export function createAppServer(
  customConfig?: Partial<AppConfig>,
  systemAdapter?: SystemUserAdapter,
  metricsOverride?: HostMetricsProvider
) {
  const config: AppConfig = { ...loadConfig(), ...customConfig };
  const vmUsers = new VmUserManager(config, systemAdapter);
  const hostMetrics: HostMetricsProvider =
    metricsOverride ?? new HostMetricsMonitor(config.maxConnectCpuAvg5m);

  const server = Bun.serve<RdpWsContext>({
    hostname: config.host,
    port: config.port,
    async fetch(req, srv) {
      const startedAt = performance.now();
      const url = new URL(req.url);
      const pathname = url.pathname;
      const isRdpWs = pathname === "/api/rdp/ws";

      const handleHttpRequest = async (): Promise<Response | undefined> => {
        if (!isAllowedFetchMetadata(req, pathname)) {
          return jsonResponse({ error: "Cross-site request blocked" }, 403);
        }

        // WebSocket endpoint for browser IronRDP WASM <-> local xrdp
        if (isRdpWs) {
          if (!verifyWsOrigin(req, config)) {
            console.warn(
              `${new Date().toISOString()} [rdp] Blocked WebSocket upgrade: origin mismatch (origin=${req.headers.get("origin")}, expected=${getExternalOrigin(req, config)})`
            );
            return jsonResponse({ error: "Invalid WebSocket origin" }, 403);
          }

          const resolved = resolveRequestIdentity(req, config);
          if (!resolved || "error" in resolved) {
            console.warn(
              `${new Date().toISOString()} [rdp] Blocked WebSocket upgrade: ${
                resolved && "error" in resolved ? resolved.error : "no IAP header or ?user= session"
              }`
            );
            return jsonResponse({ error: "Authentication required" }, 401);
          }

          const wsCtx = createRdpWsContext(resolved.session, config);
          const upgraded = srv.upgrade(req, { data: wsCtx });
          if (upgraded) {
            rdpLog(
              wsCtx,
              `WebSocket upgraded (email=${resolved.session.email}, source=${resolved.source})`
            );
            return undefined;
          }
          return jsonResponse({ error: "WebSocket upgrade failed" }, 400);
        }

        // Health checks (GET and HEAD across common probe paths)
        if (HEALTH_CHECK_PATHS.has(pathname) && (req.method === "GET" || req.method === "HEAD")) {
          return jsonResponse({ ok: true }, 200, undefined, req.method === "HEAD");
        }

        // Live host VM CPU & memory usage telemetry
        if (pathname === "/api/metrics" && req.method === "GET") {
          return jsonResponse({ metrics: hostMetrics.getSnapshot() });
        }

        // Identity lookup (read-only: inspects ?user=..., GCP IAP header, or session cookie)
        if (pathname === "/api/me" && req.method === "GET") {
          const metrics = hostMetrics.getSnapshot();
          const resolved = resolveRequestIdentity(req, config);
          if (!resolved) {
            return jsonResponse({ authenticated: false, metrics });
          }
          if ("error" in resolved) {
            return jsonResponse({ authenticated: false, error: resolved.error, metrics }, 400);
          }

          const extraHeaders = resolved.setCookie ? { "Set-Cookie": resolved.setCookie } : undefined;
          return jsonResponse(
            {
              authenticated: true,
              authSource: resolved.source,
              csrfToken: resolved.session.csrfToken,
              user: {
                email: resolved.session.email,
                username: resolved.session.username,
              },
              demos: DEMO_CATALOG,
              metrics,
            },
            200,
            extraHeaders
          );
        }

        // Automatic Linux user creation + users.yaml password generation/retrieval
        if (pathname === "/api/vm-user/ensure" && req.method === "POST") {
          const resolved = resolveRequestIdentity(req, config);
          if (!resolved || "error" in resolved) {
            return jsonResponse({ error: "Authentication required" }, 401);
          }
          if (!verifyCsrf(req, resolved.session)) {
            return jsonResponse({ error: "Invalid CSRF token" }, 403);
          }

          const extraHeaders = resolved.setCookie
            ? { "Set-Cookie": resolved.setCookie }
            : undefined;

          const metrics = hostMetrics.getSnapshot();
          if (metrics.overloaded) {
            console.warn(
              `${new Date().toISOString()} [capacity] Refused session for '${resolved.session.username}': 5m avg CPU is ${metrics.cpuAvg5mPercent}% (>= ${metrics.maxCpuAvg5mPercent}%)`
            );
            return jsonResponse(
              {
                error: RESOURCE_BUSY_MESSAGE,
                code: "RESOURCE_BUSY",
                metrics,
              },
              503,
              extraHeaders
            );
          }

          try {
            const provisioned = await vmUsers.ensureProvisionedUser(
              resolved.session.username,
              resolved.session.email
            );
            return jsonResponse(
              {
                ok: true,
                created: provisioned.created,
                user: {
                  email: provisioned.email,
                  username: provisioned.username,
                  homeDir: provisioned.homeDir,
                },
                rdpPassword: provisioned.password,
                metrics,
              },
              200,
              extraHeaders
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Failed to provision Linux user";
            console.error(
              `${new Date().toISOString()} [vm-users] Failed provisioning '${resolved.session.username}': ${msg}`
            );
            return jsonResponse({ error: msg }, 500);
          }
        }

        // Clear local cookie session (e.g. switching ?user=...) and sign out desktop session
        if (pathname === "/api/auth/logout" && req.method === "POST") {
          const resolved = resolveRequestIdentity(req, config);
          if (resolved && !("error" in resolved)) {
            if (!verifyCsrf(req, resolved.session)) {
              return jsonResponse({ error: "Invalid CSRF token" }, 403);
            }
            const logoutUser = resolved.session.username;
            void vmUsers.withUserSessionLock(logoutUser, async () => {
              await vmUsers.terminateDesktopSession(logoutUser, "disconnect");
            });
          }
          const headers = new Headers();
          for (const cookie of clearSessionCookieHeaders(req, config)) {
            headers.append("Set-Cookie", cookie);
          }
          headers.set("Clear-Site-Data", '"cookies", "storage"');
          return jsonResponse({ ok: true }, 200, headers);
        }

        if (pathname.startsWith("/api/")) {
          return jsonResponse({ error: "Not found" }, 404);
        }

        // Serve index.html for "/" and "/desktop" (also establishing cookie when ?user=... or IAP header is present)
        if (req.method === "GET" || req.method === "HEAD") {
          if (pathname === "/" || pathname === "/desktop") {
            const nonce = crypto.randomBytes(16).toString("base64");
            const diskIndex = Bun.file(path.join(config.publicDir, "index.html"));
            const indexFile =
              !config.isCompiledBinary && (await diskIndex.exists())
                ? diskIndex
                : Bun.file(EMBEDDED_PUBLIC_FILES["/index.html"]!.filePath);
            const htmlTemplate = await indexFile.text();
            const html = htmlTemplate.replaceAll("{{CSP_NONCE}}", nonce);
            const headers = new Headers({
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
            });
            const resolved = resolveRequestIdentity(req, config);
            if (resolved && !("error" in resolved) && resolved.setCookie) {
              headers.append("Set-Cookie", resolved.setCookie);
            }
            applySecurityHeaders(headers, nonce);
            return new Response(req.method === "HEAD" ? null : html, { status: 200, headers });
          }

          // Safe static asset resolution: compiled binary always prefers embedded assets so stale disk files never shadow updates
          const safeRel = path.posix.normalize(pathname).replace(/^\/+/, "");
          if (!config.isCompiledBinary) {
            const resolved = path.resolve(config.publicDir, safeRel);
            if (resolved.startsWith(config.publicDir + path.sep) && !safeRel.includes("..")) {
              const file = Bun.file(resolved);
              if (await file.exists()) {
                const ext = path.extname(resolved).toLowerCase();
                const headers = new Headers({
                  "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
                  "Cache-Control": "no-store",
                });
                applySecurityHeaders(headers);
                return new Response(req.method === "HEAD" ? null : file, { status: 200, headers });
              }
            }
          }

          const embedded = EMBEDDED_PUBLIC_FILES[`/${safeRel}`];
          if (embedded) {
            const file = Bun.file(embedded.filePath);
            const headers = new Headers({
              "Content-Type": embedded.contentType,
              "Cache-Control": "no-store",
            });
            applySecurityHeaders(headers);
            return new Response(req.method === "HEAD" ? null : file, { status: 200, headers });
          }
        }

        return jsonResponse({ error: "Not found" }, 404);
      };

      const res = await handleHttpRequest();
      if (res) {
        const durationMs = (performance.now() - startedAt).toFixed(1);
        const remoteIp =
          req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
          srv.requestIP(req)?.address ||
          "-";
        const host = req.headers.get("host") || "-";
        const ua = req.headers.get("user-agent") || "-";
        console.log(
          `${new Date().toISOString()} [http] ${req.method} ${pathname}${url.search} -> ${res.status} (${durationMs}ms) ip=${remoteIp} host=${host} ua="${ua}"`
        );
      }
      return res;
    },

    websocket: {
      maxPayloadLength: 16 * 1024 * 1024,
      idleTimeout: 900,
      sendPings: true,
      open(ws) {
        registerRdpWsOpen(ws, vmUsers);
      },
      message(ws, message) {
        handleRdpWsMessage(ws, message, config, vmUsers, hostMetrics);
      },
      close(ws, code, reason) {
        handleRdpWsClose(ws, code, reason, vmUsers);
      },
    },
  });

  return { server, config, vmUsers, hostMetrics };
}

if (import.meta.main) {
  const { server, config, vmUsers } = createAppServer();
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  console.log(
    `[Apigee AI Demos] Listening on http://${server.hostname}:${server.port} | xrdp=${config.rdpHost}:${config.rdpPort} | usersFile=${config.usersFile}${
      !isRoot ? " | privilege=sudo -n (run with sudo if passwordless sudo is not configured)" : " | privilege=root"
    }`
  );
  // Provision/update shared VM desktop & CLI apps (Antigravity, Claude Code, Claude Cowork, etc.) once at server startup for all users
  void vmUsers.ensureSystemTools().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`${new Date().toISOString()} [bootstrap] System tool bootstrap failed: ${msg}`);
  });
}
