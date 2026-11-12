import crypto from "node:crypto";
import path from "node:path";

export interface AppConfig {
  port: number;
  host: string;
  publicBaseUrl: string | null;
  trustProxy: boolean;
  sessionSecret: string;
  iapEmailHeader: string;
  rdpHost: string;
  rdpPort: number;
  useSudo: boolean;
  vmUserShell: string;
  vmUserGroups: string[];
  setupUserScript: string | null;
  onConnectScript: string | null;
  usersFile: string;
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

  let sessionSecret = env.SESSION_SECRET?.trim() ?? "";
  if (!sessionSecret) {
    sessionSecret = crypto.randomBytes(32).toString("hex");
  }

  const startDir = process.cwd();
  const isCompiledBinary = import.meta.dir.startsWith("/$bunfs");
  const baseDir = isCompiledBinary ? startDir : path.resolve(import.meta.dir, "..");

  const rawOnConnect = env.ON_CONNECT_SCRIPT?.trim();
  const onConnectScript =
    rawOnConnect && ["false", "none", "off", "0"].includes(rawOnConnect.toLowerCase())
      ? null
      : rawOnConnect
        ? path.resolve(baseDir, rawOnConnect)
        : path.join(baseDir, "scripts", "on-connect.sh");

  const usersFile = env.USERS_FILE?.trim()
    ? path.resolve(startDir, env.USERS_FILE.trim())
    : path.join(startDir, "users.yaml");

  return {
    port: parsePort(env.PORT, 8080),
    host: env.HOST?.trim() || "127.0.0.1",
    publicBaseUrl: env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") || null,
    trustProxy: parseBool(env.TRUST_PROXY, true),
    sessionSecret,
    iapEmailHeader: (env.IAP_EMAIL_HEADER?.trim() || "x-goog-authenticated-user-email").toLowerCase(),
    rdpHost: env.RDP_HOST?.trim() || "127.0.0.1",
    rdpPort: parsePort(env.RDP_PORT, 3389),
    useSudo,
    vmUserShell: env.VM_USER_SHELL?.trim() || "/bin/bash",
    vmUserGroups: (env.VM_USER_GROUPS ?? "")
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean),
    setupUserScript: env.SETUP_USER_SCRIPT?.trim() || null,
    onConnectScript,
    usersFile,
    dataDir: env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(baseDir, "data"),
    publicDir: path.join(baseDir, "public"),
  };
}
