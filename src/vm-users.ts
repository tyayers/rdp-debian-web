import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.ts";
import { POSIX_USERNAME_RE, RESERVED_USERNAMES } from "./auth.ts";
import { EMBEDDED_ON_CONNECT_SCRIPT, EMBEDDED_WALLPAPER_JPG } from "./embedded-assets.ts";

export interface StoredUserEntry {
  email: string;
  password: string;
  createdAt: string;
}

export type UsersYamlMap = Record<string, StoredUserEntry>;

export interface ProvisionedVmUser {
  username: string;
  email: string;
  homeDir: string;
  password: string;
  created: boolean;
}

interface LocalPasswdLookup {
  exists: boolean;
  uid?: number;
  gid?: number;
  homeDir: string;
}

/**
 * Optional injectable system adapter used strictly by automated tests on non-root machines.
 * Production always uses real `/etc/passwd`, `/usr/sbin/useradd`, and `/usr/sbin/chpasswd`.
 */
export interface SystemUserAdapter {
  passwdPath?: string;
  execCommand?: (argv: string[], stdinText?: string) => Promise<{ exitCode: number; stderr: string }>;
  skipSystemOnConnect?: boolean;
  onTerminateSession?: (username: string, reason: "pre-connect" | "disconnect") => Promise<void> | void;
}

const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

export function generateRandomPassword(length = 24): string {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += PASSWORD_ALPHABET[bytes[i]! % PASSWORD_ALPHABET.length];
  }
  return out;
}

function unquoteYamlScalar(val: string): string {
  const trimmed = val.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function quoteYamlIfNeeded(val: string): string {
  if (/^[A-Za-z0-9._@/-]+$/.test(val)) {
    return val;
  }
  return JSON.stringify(val);
}

export function parseUsersYaml(raw: string): UsersYamlMap {
  const map: UsersYamlMap = {};
  let currentUser: string | null = null;
  let inUsersRoot = false;

  for (const rawLine of raw.split(/\r?\n/)) {
    const commentIdx = rawLine.indexOf(" #");
    const line = (commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine).replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) {
      continue;
    }

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (indent === 0) {
      if (trimmed === "users:") {
        inUsersRoot = true;
        currentUser = null;
        continue;
      }
      inUsersRoot = false;
      const colon = trimmed.indexOf(":");
      if (colon > 0) {
        const key = trimmed.slice(0, colon).trim();
        const rest = trimmed.slice(colon + 1).trim();
        if (rest) {
          map[key] = {
            email: key,
            password: unquoteYamlScalar(rest),
            createdAt: new Date(0).toISOString(),
          };
          currentUser = null;
        } else {
          currentUser = key;
          map[key] ??= { email: key, password: "", createdAt: new Date().toISOString() };
        }
      }
      continue;
    }

    if (inUsersRoot && indent === 2) {
      const colon = trimmed.indexOf(":");
      if (colon > 0) {
        const key = trimmed.slice(0, colon).trim();
        const rest = trimmed.slice(colon + 1).trim();
        if (rest) {
          map[key] = {
            email: key,
            password: unquoteYamlScalar(rest),
            createdAt: new Date().toISOString(),
          };
          currentUser = null;
        } else {
          currentUser = key;
          map[key] ??= { email: key, password: "", createdAt: new Date().toISOString() };
        }
      }
      continue;
    }

    if (currentUser && indent >= 2) {
      const colon = trimmed.indexOf(":");
      if (colon > 0) {
        const field = trimmed.slice(0, colon).trim();
        const value = unquoteYamlScalar(trimmed.slice(colon + 1));
        const entry = map[currentUser]!;
        if (field === "email") entry.email = value;
        else if (field === "password") entry.password = value;
        else if (field === "created_at" || field === "createdAt") entry.createdAt = value;
      }
    }
  }

  // Remove any incomplete entries lacking a password
  for (const [k, v] of Object.entries(map)) {
    if (!v.password) {
      delete map[k];
    }
  }
  return map;
}

export function serializeUsersYaml(users: UsersYamlMap): string {
  const keys = Object.keys(users).sort();
  if (keys.length === 0) {
    return "# Auto-generated Linux VM users and passwords for xrdp sessions\nusers: {}\n";
  }

  const lines = [
    "# Auto-generated Linux VM users and passwords for xrdp sessions",
    "users:",
  ];
  for (const username of keys) {
    const entry = users[username]!;
    lines.push(`  ${username}:`);
    lines.push(`    email: ${quoteYamlIfNeeded(entry.email)}`);
    lines.push(`    password: ${quoteYamlIfNeeded(entry.password)}`);
    lines.push(`    created_at: ${quoteYamlIfNeeded(entry.createdAt)}`);
  }
  lines.push("");
  return lines.join("\n");
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
  private writeLock: Promise<void> = Promise.resolve();
  private readonly userSessionLocks = new Map<string, Promise<void>>();
  private readonly syncedThisBoot = new Set<string>();
  private readonly passwdPath: string;

  constructor(
    private readonly config: AppConfig,
    private readonly adapter?: SystemUserAdapter
  ) {
    this.passwdPath = adapter?.passwdPath ?? "/etc/passwd";
  }

  private async readUsersYaml(): Promise<UsersYamlMap> {
    try {
      const raw = await fs.readFile(this.config.usersFile, "utf8");
      return parseUsersYaml(raw);
    } catch {
      return {};
    }
  }

  private async writeUsersYaml(users: UsersYamlMap): Promise<void> {
    await fs.mkdir(path.dirname(this.config.usersFile), { recursive: true });
    const tmpPath = `${this.config.usersFile}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmpPath, serializeUsersYaml(users), { mode: 0o600 });
    await fs.rename(tmpPath, this.config.usersFile);
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

  /**
   * Serializes connect/sign-out lifecycle operations per Linux username so a disconnecting
   * tab's sign-out completes cleanly before a newly opened/reloaded tab starts its fresh session.
   */
  async withUserSessionLock<T>(username: string, fn: () => Promise<T>): Promise<T> {
    assertSafeUsername(username);
    const prev = this.userSessionLocks.get(username) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => gate);
    this.userSessionLocks.set(username, tail);

    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.userSessionLocks.get(username) === tail) {
        this.userSessionLocks.delete(username);
      }
    }
  }

  private async lookupLocalPasswdUser(username: string): Promise<LocalPasswdLookup> {
    assertSafeUsername(username);
    const prefix = `${username}:`;

    try {
      const passwd = await fs.readFile(this.passwdPath, "utf8");
      for (const line of passwd.split("\n")) {
        if (line.startsWith(prefix)) {
          const fields = line.trim().split(":");
          const uid = Number.parseInt(fields[2] ?? "", 10);
          const gid = Number.parseInt(fields[3] ?? "", 10);
          const homeDir = fields[5] || `/home/${username}`;
          return {
            exists: true,
            uid: Number.isNaN(uid) ? undefined : uid,
            gid: Number.isNaN(gid) ? undefined : gid,
            homeDir,
          };
        }
      }
    } catch {
      // Fall through if passwd file does not exist yet (e.g. test path)
    }

    return {
      exists: false,
      homeDir: `/home/${username}`,
    };
  }

  /**
   * Ensures the Linux user exists in `/etc/passwd` (creating via `useradd -m` if missing),
   * generates or loads their password from `users.yaml` in the service start directory,
   * and syncs their local Linux password via `chpasswd` for `xrdp` PAM login.
   */
  async ensureProvisionedUser(username: string, email: string): Promise<ProvisionedVmUser> {
    assertSafeUsername(username);

    return this.withLock(async () => {
      const nowIso = new Date().toISOString();
      const users = await this.readUsersYaml();
      let record = users[username];
      let usersYamlChanged = false;

      if (!record || !record.password) {
        record = {
          email,
          password: generateRandomPassword(24),
          createdAt: nowIso,
        };
        users[username] = record;
        usersYamlChanged = true;
      } else if (email && record.email !== email) {
        record.email = email;
        usersYamlChanged = true;
      }

      const cmdPrefix = this.config.useSudo ? ["sudo", "-n"] : [];
      let sysUser = await this.lookupLocalPasswdUser(username);

      if (sysUser.exists && sysUser.uid !== undefined && sysUser.uid < 1000) {
        throw new Error(`Account '${username}' conflicts with a system UID (${sysUser.uid})`);
      }

      let created = false;
      if (!sysUser.exists) {
        console.log(
          `${nowIso} [vm-users] User '${username}' not found in ${this.passwdPath}; creating Linux account...`
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

        await this.execSystemCommand(
          useraddArgs,
          undefined,
          `Failed to create Linux user '${username}'`
        );
        created = true;

        sysUser = await this.lookupLocalPasswdUser(username);
        if (!sysUser.exists) {
          throw new Error(
            `useradd completed for '${username}', but account was still not found in ${this.passwdPath}`
          );
        }
      }

      // Ensure home directory exists on disk even for pre-existing accounts created without -m
      if (!this.adapter) {
        try {
          await fs.mkdir(sysUser.homeDir, { recursive: true, mode: 0o755 });
          if (
            typeof process.getuid === "function" &&
            process.getuid() === 0 &&
            sysUser.uid !== undefined &&
            sysUser.gid !== undefined
          ) {
            await fs.chown(sysUser.homeDir, sysUser.uid, sysUser.gid);
          }
        } catch {
          // Best-effort; on-connect.sh also creates and chowns homeDir
        }
      }

      const syncKey = `${username}:${record.password}`;
      if (created || usersYamlChanged || !this.syncedThisBoot.has(syncKey)) {
        await this.execSystemCommand(
          [...cmdPrefix, "/usr/sbin/chpasswd"],
          `${username}:${record.password}\n`,
          `Failed to set Linux password for '${username}'`
        );
        this.syncedThisBoot.add(syncKey);
        console.log(
          `${nowIso} [vm-users] ${
            created ? "Created Linux user and set password" : "Synced Linux password"
          } for '${username}' (uid=${sysUser.uid ?? "?"}, home=${sysUser.homeDir}, store=${this.config.usersFile})`
        );
      }

      if (usersYamlChanged) {
        await this.writeUsersYaml(users);
      }

      if (created && this.config.setupUserScript) {
        await this.execSystemCommand(
          [...cmdPrefix, this.config.setupUserScript, username, sysUser.homeDir],
          undefined,
          "User created, but home-directory setup script failed"
        );
      }

      return {
        username,
        email: record.email,
        homeDir: sysUser.homeDir,
        password: record.password,
        created,
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

    let wallpaperPath = path.join(this.config.publicDir, "wallpaper.jpg");
    if (!(await Bun.file(wallpaperPath).exists())) {
      await fs.mkdir(this.config.dataDir, { recursive: true, mode: 0o755 });
      const fallbackWallpaper = path.join(this.config.dataDir, "wallpaper.jpg");
      const bytes = await Bun.file(EMBEDDED_WALLPAPER_JPG).arrayBuffer();
      await fs.writeFile(fallbackWallpaper, Buffer.from(bytes), { mode: 0o644 });
      wallpaperPath = fallbackWallpaper;
    }

    return { scriptPath, wallpaperPath };
  }

  /**
   * Installs/updates shared system-wide desktop tools once on server startup for all VM users.
   */
  async ensureSystemTools(): Promise<void> {
    if (!this.config.onConnectScript || this.adapter?.skipSystemOnConnect) {
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
    if (this.adapter?.skipSystemOnConnect && !options?.homeDirOverride) {
      if (this.adapter.onTerminateSession) {
        await this.adapter.onTerminateSession(username, "pre-connect");
      }
      return;
    }

    let homeDir = options?.homeDirOverride;
    if (!homeDir) {
      const sys = await this.lookupLocalPasswdUser(username);
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

  /**
   * Forces an immediate sign-out of any running or disconnected xrdp/LXQt graphical session
   * for `username` (invoked when the user's browser WebSocket disconnects or logs out).
   */
  async terminateDesktopSession(
    username: string,
    reason: "pre-connect" | "disconnect" = "disconnect"
  ): Promise<void> {
    assertSafeUsername(username);

    if (this.adapter?.onTerminateSession) {
      await this.adapter.onTerminateSession(username, reason);
    }
    if (!this.config.onConnectScript || this.adapter?.skipSystemOnConnect) {
      return;
    }

    const sys = await this.lookupLocalPasswdUser(username);
    if (!sys.exists) {
      return;
    }
    if (sys.uid !== undefined && sys.uid < 1000) {
      throw new Error(`Account '${username}' conflicts with a system UID (${sys.uid})`);
    }

    const { scriptPath } = await this.resolveOnConnectAssets();
    const argv = [
      ...(this.config.useSudo ? ["sudo", "-n"] : []),
      "/bin/bash",
      scriptPath,
      "--signout",
      username,
    ];

    const proc = Bun.spawn(argv, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line && !line.startsWith("[status]")) {
        console.log(`${new Date().toISOString()} ${line}`);
      }
    }

    if (exitCode !== 0) {
      const detail = stderr.trim() || `exit code ${exitCode}`;
      console.warn(
        `${new Date().toISOString()} [on-connect] Sign-out script exited with error for '${username}': ${detail}`
      );
    }
  }

  private async execSystemCommand(
    argv: string[],
    stdinText: string | undefined,
    errorContext: string
  ): Promise<void> {
    let exitCode: number;
    let stderr: string;

    if (this.adapter?.execCommand) {
      const res = await this.adapter.execCommand(argv, stdinText);
      exitCode = res.exitCode;
      stderr = res.stderr;
    } else {
      const proc = Bun.spawn(argv, {
        stdin: stdinText !== undefined ? "pipe" : "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });

      if (stdinText !== undefined && proc.stdin) {
        proc.stdin.write(stdinText);
        proc.stdin.end();
      }

      [exitCode, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stderr).text(),
      ]);
    }

    if (exitCode !== 0) {
      const detail = stderr.trim() || `exit code ${exitCode}`;
      if (/already exists/i.test(detail)) {
        throw new Error(
          `${errorContext}: ${detail} (Account '${argv.at(-1)}' is not in /etc/passwd, which indicates GCP OS Login is intercepting NSS lookups. Disable OS Login on this VM via: gcloud compute instances add-metadata <vm-name> --metadata=enable-oslogin=FALSE)`
        );
      }
      const needsPrivilegeHint =
        /permission denied|cannot lock \/etc\/passwd|a password is required|must be root|authentication failure/i.test(
          detail
        );
      const hint = needsPrivilegeHint
        ? " (Run the server with root privileges, e.g. 'sudo ./apigee-ai-demos')"
        : "";
      throw new Error(`${errorContext}: ${detail}${hint}`);
    }
  }
}
