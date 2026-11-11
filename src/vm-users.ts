import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.ts";
import { POSIX_USERNAME_RE, RESERVED_USERNAMES } from "./auth.ts";

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

  private async lookupPasswdEntry(
    username: string
  ): Promise<{ exists: boolean; uid?: number; homeDir: string }> {
    assertSafeUsername(username);
    try {
      const passwd = await fs.readFile("/etc/passwd", "utf8");
      const prefix = `${username}:`;
      for (const line of passwd.split("\n")) {
        if (line.startsWith(prefix)) {
          const fields = line.split(":");
          const uid = Number.parseInt(fields[2] ?? "", 10);
          const homeDir = fields[5] || `/home/${username}`;
          return { exists: true, uid, homeDir };
        }
      }
    } catch {
      // Fallback if /etc/passwd unreadable
    }
    return { exists: false, homeDir: `/home/${username}` };
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

    const sys = await this.lookupPasswdEntry(username);
    // Prevent modifying pre-existing low-UID system accounts (< 1000)
    if (sys.exists && sys.uid !== undefined && sys.uid < 1000) {
      throw new Error(`Account '${username}' conflicts with a system UID (${sys.uid})`);
    }

    return {
      username,
      existsOnSystem: sys.exists,
      provisioned: sys.exists && Boolean(record),
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

      const sysBefore = await this.lookupPasswdEntry(username);
      if (sysBefore.exists && sysBefore.uid !== undefined && sysBefore.uid < 1000) {
        throw new Error(`Account '${username}' conflicts with a system UID (${sysBefore.uid})`);
      }

      const cmdPrefix = this.config.useSudo ? ["sudo", "-n"] : [];
      let created = false;

      if (!sysBefore.exists) {
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
      }

      // Update user password via chpasswd stdin (never expose password in process argv)
      await this.execCommand(
        [...cmdPrefix, "/usr/sbin/chpasswd"],
        `${username}:${password}\n`,
        "Failed to set local VM password"
      );

      const sysAfter = await this.lookupPasswdEntry(username);

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
        `${nowIso} [vm-users] SYSTEM mode: ${created ? "created Linux user" : "updated Linux password for"} '${username}' (uid=${sysAfter.uid ?? "?"}, home=${sysAfter.homeDir})`
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
      throw new Error(`${errorContext}: ${detail}`);
    }
  }
}
