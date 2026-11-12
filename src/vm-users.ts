import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.ts";
import { POSIX_USERNAME_RE, RESERVED_USERNAMES } from "./auth.ts";
import { EMBEDDED_ON_CONNECT_SCRIPT, EMBEDDED_WALLPAPER_PNG } from "./embedded-assets.ts";

export interface VmUserStatus {
  username: string;
  existsOnSystem: boolean;
  provisioned: boolean;
  homeDir: string;
  createdAt: string | null;
  passwordUpdatedAt: string | null;
}

interface ProvisionedRecord {
  email: string;
  homeDir: string;
  createdAt: string;
  passwordUpdatedAt: string;
  mockPasswordHash?: string;
}

type RegistryMap = Record<string, ProvisionedRecord>;

interface SystemUserLookup {
  exists: boolean;
  inEtcPasswd: boolean;
  uid?: number;
  homeDir: string;
}

export function validateVmPassword(password: string): string | null {
  if (typeof password !== "string" || password.length < 8) {
    return "Password must be at least 8 characters long.";
  }
  if (password.length > 128) {
    return "Password must not exceed 128 characters.";
  }
  if (/[\r\n\0]/.test(password)) {
    return "Password contains disallowed control characters.";
  }
  return null;
}

function assertSafeUsername(username: string): void {
  if (!POSIX_USERNAME_RE.test(username)) {
    throw new Error(`Invalid POSIX username: ${username}`);
  }
  if (RESERVED_USERNAMES.has(username)) {
    throw new Error(`Refusing operation on reserved system account: ${username}`);
  }
}

export class VmUserManager {
  private readonly registryPath: string;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(private readonly config: AppConfig) {
    const filename =
      config.vmUserMode === "mock" ? "mock-vm-users.json" : "provisioned-vm-users.json";
    this.registryPath = path.join(config.dataDir, filename);
  }

  private async readRegistry(): Promise<RegistryMap> {
    try {
      const raw = await fs.readFile(this.registryPath, "utf8");
      return JSON.parse(raw) as RegistryMap;
    } catch {
      return {};
    }
  }

  private async writeRegistry(data: RegistryMap): Promise<void> {
    await fs.mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    const tmpPath = `${this.registryPath}.tmp.${process.pid}`;
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(tmpPath, this.registryPath);
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.writeLock;
    let release!: () => void;
    this.writeLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private parsePasswdLine(line: string, username: string): { uid?: number; homeDir: string } {
    const fields = line.trim().split(":");
    const uid = Number.parseInt(fields[2] ?? "", 10);
    const homeDir = fields[5] || `/home/${username}`;
    return {
      uid: Number.isNaN(uid) ? undefined : uid,
      homeDir,
    };
  }

  private async lookupSystemUser(username: string): Promise<SystemUserLookup> {
    assertSafeUsername(username);
    const prefix = `${username}:`;

    // 1. Check local /etc/passwd first
    try {
      const passwd = await fs.readFile("/etc/passwd", "utf8");
      for (const line of passwd.split("\n")) {
        if (line.startsWith(prefix)) {
          const parsed = this.parsePasswdLine(line, username);
          return {
            exists: true,
            inEtcPasswd: true,
            uid: parsed.uid,
            homeDir: parsed.homeDir,
          };
        }
      }
    } catch {
      // Continue to getent fallback
    }

    // 2. Check NSS (e.g. getent passwd <username> for LDAP / OS Login / SSSD accounts)
    try {
      const proc = Bun.spawn(["getent", "passwd", "--", username], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      const [code, stdout] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
      ]);
      if (code === 0 && stdout.startsWith(prefix)) {
        const parsed = this.parsePasswdLine(stdout.split("\n")[0]!, username);
        return {
          exists: true,
          inEtcPasswd: false,
          uid: parsed.uid,
          homeDir: parsed.homeDir,
        };
      }
    } catch {
      // getent unavailable
    }

    return {
      exists: false,
      inEtcPasswd: false,
      homeDir: `/home/${username}`,
    };
  }

  async getStatus(username: string): Promise<VmUserStatus> {
    assertSafeUsername(username);
    const registry = await this.readRegistry();
    const record = registry[username];

    if (this.config.vmUserMode === "mock") {
      return {
        username,
        existsOnSystem: Boolean(record),
        provisioned: Boolean(record),
        homeDir: record?.homeDir ?? `/home/${username}`,
        createdAt: record?.createdAt ?? null,
        passwordUpdatedAt: record?.passwordUpdatedAt ?? null,
      };
    }

    const sys = await this.lookupSystemUser(username);
    // Prevent modifying pre-existing low-UID system accounts (< 1000)
    if (sys.exists && sys.uid !== undefined && sys.uid < 1000) {
      throw new Error(`Account '${username}' conflicts with a system UID (${sys.uid})`);
    }

    // If the Linux user already exists on the VM, use it directly without forcing creation
    return {
      username,
      existsOnSystem: sys.exists,
      provisioned: sys.exists,
      homeDir: sys.homeDir,
      createdAt: record?.createdAt ?? null,
      passwordUpdatedAt: record?.passwordUpdatedAt ?? null,
    };
  }

  async setupOrUpdatePassword(
    username: string,
    email: string,
    password: string
  ): Promise<{ created: boolean; status: VmUserStatus }> {
    assertSafeUsername(username);
    const pwErr = validateVmPassword(password);
    if (pwErr) {
      throw new Error(pwErr);
    }

    return this.withLock(async () => {
      const nowIso = new Date().toISOString();
      const registry = await this.readRegistry();
      const existingRecord = registry[username];

      if (this.config.vmUserMode === "mock") {
        const salt = crypto.randomBytes(16).toString("hex");
        const hash = crypto.scryptSync(password, salt, 32).toString("hex");
        const created = !existingRecord;
        registry[username] = {
          email,
          homeDir: `/home/${username}`,
          createdAt: existingRecord?.createdAt ?? nowIso,
          passwordUpdatedAt: nowIso,
          mockPasswordHash: `${salt}:${hash}`,
        };
        await this.writeRegistry(registry);
        console.log(
          `${nowIso} [vm-users] MOCK mode: ${created ? "created" : "updated password for"} mock user '${username}' (${email}) — note: Linux /etc/passwd was NOT modified`
        );
        return {
          created,
          status: {
            username,
            existsOnSystem: true,
            provisioned: true,
            homeDir: `/home/${username}`,
            createdAt: registry[username]!.createdAt,
            passwordUpdatedAt: nowIso,
          },
        };
      }

      const sysBefore = await this.lookupSystemUser(username);
      if (sysBefore.exists && sysBefore.uid !== undefined && sysBefore.uid < 1000) {
        throw new Error(`Account '${username}' conflicts with a system UID (${sysBefore.uid})`);
      }

      const cmdPrefix = this.config.useSudo ? ["sudo", "-n"] : [];
      let created = false;

      if (!sysBefore.exists) {
        console.log(
          `${nowIso} [vm-users] User '${username}' not found on system; creating via ${this.config.useSudo ? "sudo useradd" : "useradd"}`
        );
        const useraddArgs = [
          ...cmdPrefix,
          "/usr/sbin/useradd",
          "-m",
          "-s",
          this.config.vmUserShell,
        ];
        if (this.config.vmUserGroups.length > 0) {
          useraddArgs.push("-G", this.config.vmUserGroups.join(","));
        }
        useraddArgs.push("--", username);

        await this.execCommand(useraddArgs, undefined, "Failed to create local VM user");
        created = true;
      } else {
        console.log(
          `${nowIso} [vm-users] User '${username}' already exists on system (uid=${sysBefore.uid ?? "?"}, inEtcPasswd=${sysBefore.inEtcPasswd}); skipping useradd and updating password`
        );
      }

      // Set or reset user password via chpasswd stdin (never expose password in process argv)
      await this.execCommand(
        [...cmdPrefix, "/usr/sbin/chpasswd"],
        `${username}:${password}\n`,
        sysBefore.exists && !sysBefore.inEtcPasswd
          ? `Failed to set local password (account '${username}' is managed outside /etc/passwd, e.g. OS Login/LDAP)`
          : "Failed to set local VM password"
      );

      const sysAfter = await this.lookupSystemUser(username);

      // Optional hook for future home-directory customization
      if (created && this.config.setupUserScript) {
        await this.execCommand(
          [...cmdPrefix, this.config.setupUserScript, username, sysAfter.homeDir],
          undefined,
          "User created, but home-directory setup script failed"
        );
      }

      registry[username] = {
        email,
        homeDir: sysAfter.homeDir,
        createdAt: existingRecord?.createdAt ?? nowIso,
        passwordUpdatedAt: nowIso,
      };
      await this.writeRegistry(registry);
      console.log(
        `${nowIso} [vm-users] SYSTEM mode: ${created ? "created Linux user and set password for" : "reset/updated Linux password for"} '${username}' (uid=${sysAfter.uid ?? "?"}, home=${sysAfter.homeDir})`
      );

      return {
        created,
        status: {
          username,
          existsOnSystem: true,
          provisioned: true,
          homeDir: sysAfter.homeDir,
          createdAt: registry[username]!.createdAt,
          passwordUpdatedAt: nowIso,
        },
      };
    });
  }

  private async resolveOnConnectAssets(): Promise<{ scriptPath: string; wallpaperPath: string }> {
    let scriptPath = this.config.onConnectScript!;
    if (!(await Bun.file(scriptPath).exists())) {
      await fs.mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
      const fallbackPath = path.join(this.config.dataDir, "on-connect.default.sh");
      const embeddedText = await Bun.file(EMBEDDED_ON_CONNECT_SCRIPT).text();
      await fs.writeFile(fallbackPath, embeddedText, { mode: 0o755 });
      scriptPath = fallbackPath;
    }

    let wallpaperPath = path.join(this.config.publicDir, "wallpaper.png");
    if (!(await Bun.file(wallpaperPath).exists())) {
      await fs.mkdir(this.config.dataDir, { recursive: true, mode: 0o755 });
      const fallbackWallpaper = path.join(this.config.dataDir, "wallpaper.png");
      const bytes = await Bun.file(EMBEDDED_WALLPAPER_PNG).arrayBuffer();
      await fs.writeFile(fallbackWallpaper, Buffer.from(bytes), { mode: 0o644 });
      wallpaperPath = fallbackWallpaper;
    }

    return { scriptPath, wallpaperPath };
  }

  /**
   * Installs/updates shared system-wide desktop tools (Plank, QTerminal, PCManFM-Qt, FeatherPad,
   * VSCodium, Google Chrome, Antigravity CLI & IDE) once on server startup for all VM users.
   */
  async ensureSystemTools(): Promise<void> {
    if (!this.config.onConnectScript || this.config.vmUserMode === "mock") {
      return;
    }

    const { scriptPath, wallpaperPath } = await this.resolveOnConnectAssets();
    const argv = [
      ...(this.config.useSudo ? ["sudo", "-n"] : []),
      "/bin/bash",
      scriptPath,
      "--system-only",
    ];

    const proc = Bun.spawn(argv, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ON_CONNECT_WALLPAPER_SRC: wallpaperPath },
    });

    const streamStdout = async () => {
      if (!proc.stdout) return;
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nlIdx: number;
        while ((nlIdx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nlIdx).trim();
          buf = buf.slice(nlIdx + 1);
          if (line) console.log(`${new Date().toISOString()} [bootstrap] ${line}`);
        }
      }
      const tail = buf.trim();
      if (tail) console.log(`${new Date().toISOString()} [bootstrap] ${tail}`);
    };

    const [exitCode, , stderr] = await Promise.all([
      proc.exited,
      streamStdout(),
      new Response(proc.stderr).text(),
    ]);

    if (exitCode !== 0) {
      console.warn(
        `${new Date().toISOString()} [bootstrap] System tool check exited with code ${exitCode}: ${stderr.trim()}`
      );
    }
  }

  async runOnConnectHook(
    username: string,
    options?: {
      homeDirOverride?: string;
      envOverrides?: Record<string, string>;
      onProgress?: (statusText: string) => void;
    }
  ): Promise<void> {
    assertSafeUsername(username);
    if (!this.config.onConnectScript) {
      return;
    }

    if (this.config.vmUserMode === "mock" && !options?.homeDirOverride) {
      return;
    }

    let homeDir = options?.homeDirOverride;
    if (!homeDir) {
      const sys = await this.lookupSystemUser(username);
      if (sys.exists && sys.uid !== undefined && sys.uid < 1000) {
        throw new Error(`Account '${username}' conflicts with a system UID (${sys.uid})`);
      }
      homeDir = sys.homeDir;
    }

    const { scriptPath, wallpaperPath } = await this.resolveOnConnectAssets();

    const useSudo = this.config.useSudo && !options?.homeDirOverride;
    const argv = [...(useSudo ? ["sudo", "-n"] : []), "/bin/bash", scriptPath, username, homeDir];

    const proc = Bun.spawn(argv, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ON_CONNECT_WALLPAPER_SRC: wallpaperPath,
        ...(options?.envOverrides ?? {}),
      },
    });

    // Stream stdout line-by-line so first-time package installs emit live progress to the UI
    const streamStdout = async () => {
      if (!proc.stdout) return;
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nlIdx: number;
        while ((nlIdx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nlIdx).trim();
          buf = buf.slice(nlIdx + 1);
          if (!line) continue;
          console.log(`${new Date().toISOString()} ${line}`);
          if (line.startsWith("[status]") && options?.onProgress) {
            options.onProgress(line.slice("[status]".length).trim());
          }
        }
      }
      const tail = buf.trim();
      if (tail) {
        console.log(`${new Date().toISOString()} ${tail}`);
        if (tail.startsWith("[status]") && options?.onProgress) {
          options.onProgress(tail.slice("[status]".length).trim());
        }
      }
    };

    const [exitCode, , stderr] = await Promise.all([
      proc.exited,
      streamStdout(),
      new Response(proc.stderr).text(),
    ]);

    if (exitCode !== 0) {
      const detail = stderr.trim() || `exit code ${exitCode}`;
      console.warn(
        `${new Date().toISOString()} [on-connect] Enforcement script '${scriptPath}' exited with error for '${username}': ${detail}`
      );
      if (options?.homeDirOverride) {
        throw new Error(`on-connect script failed: ${detail}`);
      }
    }
  }

  private async execCommand(
    argv: string[],
    stdinText: string | undefined,
    errorContext: string
  ): Promise<void> {
    const proc = Bun.spawn(argv, {
      stdin: stdinText !== undefined ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    if (stdinText !== undefined && proc.stdin) {
      proc.stdin.write(stdinText);
      proc.stdin.end();
    }

    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);

    if (exitCode !== 0) {
      const detail = stderr.trim() || `exit code ${exitCode}`;
      const needsPrivilegeHint =
        /permission denied|cannot lock \/etc\/passwd|a password is required|must be root|authentication failure/i.test(
          detail
        );
      const hint = needsPrivilegeHint
        ? " (Run the server with root privileges, e.g. 'sudo bun run start', or allow passwordless sudo for /usr/sbin/useradd and /usr/sbin/chpasswd in /etc/sudoers.d/)"
        : "";
      throw new Error(`${errorContext}: ${detail}${hint}`);
    }
  }
}
