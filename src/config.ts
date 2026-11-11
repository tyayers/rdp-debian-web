import crypto from "node:crypto";
import path from "node:path";

export type VmUserMode = "system" | "mock";

export interface AppConfig {
  port: number;
  host: string;
  publicBaseUrl: string | null;
  trustProxy: boolean;
  sessionSecret: string;
  googleClientId: string;
  googleClientSecret: string;
  allowedGoogleDomain: string;
  allowDevAuth: boolean;
  rdpHost: string;
  rdpPort: number;
  vmUserMode: VmUserMode;
  useSudo: boolean;
  vmUserShell: string;
  vmUserGroups: string[];
  setupUserScript: string | null;
  dataDir: string;
  publicDir: string;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : fallback;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  // Automatically use `sudo -n` when not running as root unless explicitly disabled via USE_SUDO=false
  const useSudo = !isRoot && parseBool(env.USE_SUDO, true);

  let vmUserMode: VmUserMode = isRoot || useSudo ? "system" : "system";
  if (env.VM_USER_MODE === "mock") {
    vmUserMode = "mock";
  } else if (env.VM_USER_MODE === "system") {
    vmUserMode = "system";
  }

  let sessionSecret = env.SESSION_SECRET?.trim() ?? "";
  if (!sessionSecret) {
    sessionSecret = crypto.randomBytes(32).toString("hex");
    if (env.NODE_ENV !== "test") {
      console.warn(
        "[config] SESSION_SECRET not set; generated an ephemeral secret for this process. Set SESSION_SECRET in production."
      );
    }
  }

  const projectRoot = path.resolve(import.meta.dir, "..");

  return {
    port: parsePort(env.PORT, 8080),
    host: env.HOST?.trim() || "127.0.0.1",
    publicBaseUrl: env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") || null,
    trustProxy: parseBool(env.TRUST_PROXY, true),
    sessionSecret,
    googleClientId: env.GOOGLE_CLIENT_ID?.trim() ?? "",
    googleClientSecret: env.GOOGLE_CLIENT_SECRET?.trim() ?? "",
    allowedGoogleDomain: (env.ALLOWED_GOOGLE_DOMAIN?.trim() || "google.com").toLowerCase(),
    allowDevAuth: parseBool(env.ALLOW_DEV_AUTH, false),
    rdpHost: env.RDP_HOST?.trim() || "127.0.0.1",
    rdpPort: parsePort(env.RDP_PORT, 3389),
    vmUserMode,
    useSudo,
    vmUserShell: env.VM_USER_SHELL?.trim() || "/bin/bash",
    vmUserGroups: (env.VM_USER_GROUPS ?? "")
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean),
    setupUserScript: env.SETUP_USER_SCRIPT?.trim() || null,
    dataDir: env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(projectRoot, "data"),
    publicDir: path.join(projectRoot, "public"),
  };
}
