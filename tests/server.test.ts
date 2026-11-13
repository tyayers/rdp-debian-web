import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { deriveLinuxUsername, parseUserIdentity } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";
import { HostMetricsMonitor, RESOURCE_BUSY_MESSAGE, type HostMetricsProvider } from "../src/host-metrics.ts";
import { createAppServer } from "../src/server.ts";
import { parseUsersYaml, VmUserManager, type SystemUserAdapter } from "../src/vm-users.ts";

async function generateSelfSignedPem(dir: string): Promise<{ key: string; cert: string }> {
  const keyPath = path.join(dir, "xrdp-test.key");
  const certPath = path.join(dir, "xrdp-test.crt");
  const proc = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ],
    { stdout: "ignore", stderr: "pipe" }
  );
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error("openssl failed generating test cert");
  }
  return {
    key: await fs.readFile(keyPath, "utf8"),
    cert: await fs.readFile(certPath, "utf8"),
  };
}

describe("Apigee AI Journeys — GCP IAP / ?user= Auth, users.yaml Auto-Provisioning, and IronRDP WASM", () => {
  let tmpDir = "";
  let fakePasswdPath = "";
  let usersYamlPath = "";
  let executedCommands: Array<{ argv: string[]; stdin?: string }> = [];
  let terminatedEvents: Array<{ username: string; reason: "pre-connect" | "disconnect" }> = [];
  let repositionedUsers: string[] = [];
  let simulatedCpu5m = 18.5;
  let mockRdpServer: net.Server;
  let mockRdpPort = 0;
  let receivedMcsConnectInitial: Buffer | null = null;
  let app: ReturnType<typeof createAppServer>;
  let baseUrl = "";

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "apigee-rdp-test-"));
    fakePasswdPath = path.join(tmpDir, "etc-passwd");
    usersYamlPath = path.join(tmpDir, "users.yaml");
    await fs.writeFile(
      fakePasswdPath,
      [
        "root:x:0:0:root:/root:/bin/bash",
        "existinguser:x:1000:1000::/home/existinguser:/bin/bash",
        "",
      ].join("\n")
    );

    const tlsCreds = await generateSelfSignedPem(tmpDir);

    mockRdpServer = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      const onInitial = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length < 4) return;
        const tpktLen = buf.readUInt16BE(2);
        if (buf.length < tpktLen) return;
        sock.off("data", onInitial);

        const confirm = Buffer.from([
          0x03, 0x00, 0x00, 0x13,
          0x0e,
          0xd0,
          0x00, 0x00,
          0x12, 0x34,
          0x00,
          0x02,
          0x00,
          0x08, 0x00,
          0x01, 0x00, 0x00, 0x00,
        ]);
        sock.write(confirm, () => {
          const tlsServer = new tls.TLSSocket(sock, {
            isServer: true,
            key: tlsCreds.key,
            cert: tlsCreds.cert,
          });
          tlsServer.on("data", (decrypted: Buffer) => {
            if (!receivedMcsConnectInitial) {
              receivedMcsConnectInitial = Buffer.from(decrypted);
            }
          });
          tlsServer.on("error", () => {});
        });
      };
      sock.on("data", onInitial);
      sock.on("error", () => {});
    });

    await new Promise<void>((resolve) => {
      mockRdpServer.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = mockRdpServer.address();
    mockRdpPort = typeof addr === "object" && addr ? addr.port : 0;

    let nextUid = 1001;
    const systemAdapter: SystemUserAdapter = {
      passwdPath: fakePasswdPath,
      skipSystemOnConnect: true,
      onTerminateSession: async (username, reason) => {
        terminatedEvents.push({ username, reason });
      },
      onRepositionPlank: async (username) => {
        repositionedUsers.push(username);
      },
      execCommand: async (argv, stdinText) => {
        executedCommands.push({ argv, stdin: stdinText });
        if (argv.includes("/usr/sbin/useradd")) {
          const newUsername = argv.at(-1)!;
          const uid = nextUid++;
          await fs.appendFile(
            fakePasswdPath,
            `${newUsername}:x:${uid}:${uid}::/home/${newUsername}:/bin/bash\n`
          );
        }
        return { exitCode: 0, stderr: "" };
      },
    };

    const testMetricsProvider: HostMetricsProvider = {
      getSnapshot: () => ({
        cpuCurrentPercent: simulatedCpu5m,
        cpuAvg5mPercent: simulatedCpu5m,
        cpuCores: 4,
        memUsedBytes: 3 * 1024 * 1024 * 1024,
        memTotalBytes: 8 * 1024 * 1024 * 1024,
        memUsedPercent: 37.5,
        maxCpuAvg5mPercent: 70,
        overloaded: simulatedCpu5m >= 70,
        updatedAt: new Date().toISOString(),
      }),
      stop: () => {},
    };

    app = createAppServer(
      {
        host: "127.0.0.1",
        port: 0,
        sessionSecret: crypto.randomBytes(32).toString("hex"),
        rdpHost: "127.0.0.1",
        rdpPort: mockRdpPort,
        usersFile: usersYamlPath,
        dataDir: path.join(tmpDir, "data"),
      },
      systemAdapter,
      testMetricsProvider
    );
    baseUrl = `http://127.0.0.1:${app.server.port}`;
  });

  afterAll(async () => {
    app?.server.stop(true);
    await new Promise<void>((resolve) => mockRdpServer.close(() => resolve()));
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("serves Apigee AI Journeys frontend with CSP nonce and defaults usersFile to start directory", async () => {
    const defaultCfg = loadConfig({ NODE_ENV: "test" });
    expect(defaultCfg.usersFile).toBe(path.join(process.cwd(), "users.yaml"));

    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("'wasm-unsafe-eval'");
    const html = await res.text();
    expect(html).toContain("<title>Apigee AI Journeys</title>");
    expect(html).not.toContain("Fit display");
    expect(html).not.toContain("{{CSP_NONCE}}");

    const headRoot = await fetch(`${baseUrl}/`, { method: "HEAD" });
    expect(headRoot.status).toBe(200);

    for (const hcPath of [
      "/api/health",
      "/health",
      "/healthz",
      "/livez",
      "/readyz",
      "/ping",
      "/status",
    ]) {
      const getHc = await fetch(`${baseUrl}${hcPath}`);
      expect(getHc.status).toBe(200);
      expect(await getHc.json()).toEqual({ ok: true });

      const headHc = await fetch(`${baseUrl}${hcPath}`, { method: "HEAD" });
      expect(headHc.status).toBe(200);
    }
  });

  test("parseUserIdentity parses GCP IAP headers, arbitrary emails (?user=test@example.com), and rejects reserved accounts", () => {
    expect(parseUserIdentity("accounts.google.com:tyayers@google.com")).toEqual({
      email: "tyayers@google.com",
      username: "tyayers",
    });
    expect(parseUserIdentity("test@example.com")).toEqual({
      email: "test@example.com",
      username: "test",
    });
    expect(deriveLinuxUsername("Jane.Doe+demo@example.org")).toBe("jane_doe_demo");
    expect(() => deriveLinuxUsername("root@example.com")).toThrow();
    expect(() => deriveLinuxUsername("xrdp")).toThrow();
  });

  test("authenticates via GCP IAP header and ?user= URL parameter, creates missing Linux user via useradd, and persists generated passwords in users.yaml", async () => {
    // 1. Unauthenticated when neither IAP header nor ?user= is provided
    const unauthMe = await (await fetch(`${baseUrl}/api/me`)).json();
    expect(unauthMe.authenticated).toBe(false);

    // 2. GCP IAP header authentication (accounts.google.com:alice.smith@google.com -> alice_smith)
    const iapHeaders = {
      "X-Goog-Authenticated-User-Email": "accounts.google.com:alice.smith@google.com",
    };
    const iapMeRes = await fetch(`${baseUrl}/api/me`, { headers: iapHeaders });
    expect(iapMeRes.status).toBe(200);
    const iapCookie = iapMeRes.headers.get("set-cookie")!.split(";")[0]!;
    const iapMe = await iapMeRes.json();
    expect(iapMe.authenticated).toBe(true);
    expect(iapMe.authSource).toBe("iap");
    expect(iapMe.user.username).toBe("alice_smith");

    // Ensure CSRF is enforced on POST /api/vm-user/ensure
    const noCsrf = await fetch(`${baseUrl}/api/vm-user/ensure`, {
      method: "POST",
      headers: { ...iapHeaders, Cookie: iapCookie },
    });
    expect(noCsrf.status).toBe(403);

    // Provision missing user alice_smith -> runs useradd + chpasswd + writes users.yaml
    const ensureAliceRes = await fetch(`${baseUrl}/api/vm-user/ensure`, {
      method: "POST",
      headers: {
        ...iapHeaders,
        Cookie: iapCookie,
        "X-CSRF-Token": iapMe.csrfToken,
      },
    });
    expect(ensureAliceRes.status).toBe(200);
    const ensureAlice = await ensureAliceRes.json();
    expect(ensureAlice.created).toBe(true);
    expect(ensureAlice.user.username).toBe("alice_smith");
    expect(ensureAlice.user.homeDir).toBe("/home/alice_smith");
    expect(ensureAlice.rdpPassword.length).toBe(24);

    // Verify useradd and chpasswd were actually invoked
    expect(
      executedCommands.some(
        (c) => c.argv.includes("/usr/sbin/useradd") && c.argv.at(-1) === "alice_smith"
      )
    ).toBe(true);
    expect(
      executedCommands.some(
        (c) =>
          c.argv.includes("/usr/sbin/chpasswd") &&
          c.stdin === `alice_smith:${ensureAlice.rdpPassword}\n`
      )
    ).toBe(true);

    // 3. Direct ?user=test@example.com URL parameter authentication & existing user handling
    const queryMeRes = await fetch(`${baseUrl}/api/me?user=test@example.com`);
    const queryCookie = queryMeRes.headers.get("set-cookie")!.split(";")[0]!;
    const queryMe = await queryMeRes.json();
    expect(queryMe.authenticated).toBe(true);
    expect(queryMe.authSource).toBe("query");
    expect(queryMe.user.username).toBe("test");

    const ensureTestRes = await fetch(`${baseUrl}/api/vm-user/ensure?user=test@example.com`, {
      method: "POST",
      headers: {
        Cookie: queryCookie,
        "X-CSRF-Token": queryMe.csrfToken,
      },
    });
    const ensureTest = await ensureTestRes.json();
    expect(ensureTest.created).toBe(true);
    expect(ensureTest.user.username).toBe("test");

    // Calling ensure again reuses the exact stored password without re-running useradd
    const countBefore = executedCommands.filter((c) => c.argv.includes("/usr/sbin/useradd")).length;
    const ensureTestAgain = await (
      await fetch(`${baseUrl}/api/vm-user/ensure?user=test@example.com`, {
        method: "POST",
        headers: {
          Cookie: queryCookie,
          "X-CSRF-Token": queryMe.csrfToken,
        },
      })
    ).json();
    expect(ensureTestAgain.created).toBe(false);
    expect(ensureTestAgain.rdpPassword).toBe(ensureTest.rdpPassword);
    expect(executedCommands.filter((c) => c.argv.includes("/usr/sbin/useradd")).length).toBe(
      countBefore
    );

    // 4. Pre-existing user in /etc/passwd ("existinguser") skips useradd and stores generated password in users.yaml
    const existingMeRes = await fetch(`${baseUrl}/api/me?user=existinguser@example.com`);
    const existingCookie = existingMeRes.headers.get("set-cookie")!.split(";")[0]!;
    const existingMe = await existingMeRes.json();
    const ensureExisting = await (
      await fetch(`${baseUrl}/api/vm-user/ensure?user=existinguser@example.com`, {
        method: "POST",
        headers: {
          Cookie: existingCookie,
          "X-CSRF-Token": existingMe.csrfToken,
        },
      })
    ).json();
    expect(ensureExisting.created).toBe(false);
    expect(ensureExisting.rdpPassword.length).toBe(24);

    // Verify users.yaml on disk contains all 3 users and their generated passwords
    const rawYaml = await fs.readFile(usersYamlPath, "utf8");
    const parsedYaml = parseUsersYaml(rawYaml);
    expect(parsedYaml["alice_smith"]?.password).toBe(ensureAlice.rdpPassword);
    expect(parsedYaml["alice_smith"]?.email).toBe("alice.smith@google.com");
    expect(parsedYaml["test"]?.password).toBe(ensureTest.rdpPassword);
    expect(parsedYaml["test"]?.email).toBe("test@example.com");
    expect(parsedYaml["existinguser"]?.password).toBe(ensureExisting.rdpPassword);
  });

  test("IronRDP WASM module + Bun WebSocket proxy auto-provisions user and sends MCS ConnectInitial using ?user= parameter", async () => {
    const wasmResp = await fetch(`${baseUrl}/wasm/rdp_wasm_bg.wasm`);
    expect(wasmResp.status).toBe(200);
    const wasmBytes = await wasmResp.arrayBuffer();

    const wasmJsModule = (await import("../public/wasm/rdp_wasm.js")) as {
      default: (input: { module_or_path: ArrayBuffer }) => Promise<unknown>;
      RdpSession: new (
        w: number,
        h: number,
        u: string,
        p: string,
        d: string,
        onSend: (kind: number, bytes: Uint8Array) => void,
        onConnected: (w: number, h: number) => void,
        onResize: (w: number, h: number) => void,
        onDraw: (px: Uint8Array, x: number, y: number, w: number, h: number) => void,
        onCursor: (kind: number) => void,
        onClip: (text: string) => void,
        onTerm: (reason: string) => void,
        onLog: (msg: string) => void
      ) => {
        start: () => void;
        on_tls_ready: (confirm: Uint8Array) => void;
        free: () => void;
      };
    };

    await wasmJsModule.default({ module_or_path: wasmBytes });

    // Connect directly via ?user=rdp.tester@example.com without any prior setup call!
    const wsUrl =
      baseUrl.replace("http://", "ws://") + "/api/rdp/ws?user=rdp.tester%40example.com";
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";

    const session = new wasmJsModule.RdpSession(
      1280,
      800,
      "rdp_tester",
      "AutoGeneratedPass123",
      "",
      (kind: number, payload: Uint8Array) => {
        const packet = new Uint8Array(1 + payload.length);
        packet[0] = kind;
        packet.set(payload, 1);
        ws.send(packet);
      },
      () => {},
      () => {},
      () => {},
      () => {},
      () => {},
      () => {},
      () => {}
    );

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for MCS ConnectInitial")),
        5000
      );

      ws.addEventListener("open", () => {
        try {
          session.start();
        } catch (err) {
          reject(err);
        }
      });

      ws.addEventListener("message", (ev) => {
        const data = new Uint8Array(ev.data as ArrayBuffer);
        if (data[0] === 0x02) {
          try {
            session.on_tls_ready(data.subarray(1));
          } catch (err) {
            reject(err);
            return;
          }
          const poll = setInterval(() => {
            if (receivedMcsConnectInitial && receivedMcsConnectInitial.length > 20) {
              clearInterval(poll);
              clearTimeout(timeout);
              resolve();
            }
          }, 20);
        }
      });

      ws.addEventListener("error", () => reject(new Error("WebSocket error")));
    });

    session.free();

    const closedPromise = new Promise<void>((resolve) => {
      ws.addEventListener("close", () => resolve());
    });
    ws.close();
    await closedPromise;

    // Wait briefly for the async post-disconnect sign-out lock task to complete
    for (let i = 0; i < 30; i++) {
      if (
        terminatedEvents.some(
          (e) => e.username === "rdp_tester" && e.reason === "disconnect"
        )
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }

    // Verify pre-connect reset ran before connecting AND disconnect sign-out ran on close!
    const testerEvents = terminatedEvents
      .filter((e) => e.username === "rdp_tester")
      .map((e) => e.reason);
    expect(testerEvents).toEqual(["pre-connect", "disconnect"]);

    // Verify WebSocket handshake also auto-created rdp_tester in /etc/passwd and users.yaml!
    const rawYaml = await fs.readFile(usersYamlPath, "utf8");
    const parsedYaml = parseUsersYaml(rawYaml);
    expect(parsedYaml["rdp_tester"]?.email).toBe("rdp.tester@example.com");
    expect(parsedYaml["rdp_tester"]?.password.length).toBe(24);
    expect(receivedMcsConnectInitial).not.toBeNull();
  });

  test("superseding an open tab closes the old WebSocket (4001), starts a fresh login, and only signs out after the new tab disconnects", async () => {
    const x224RequestFrame = new Uint8Array([
      0x01, // FRAME_X224_REQ
      0x03, 0x00, 0x00, 0x13,
      0x0e,
      0xe0,
      0x00, 0x00,
      0x00, 0x00,
      0x00,
      0x01, 0x00, 0x08, 0x00,
      0x01, 0x00, 0x00, 0x00,
    ]);

    const wsUrl =
      baseUrl.replace("http://", "ws://") + "/api/rdp/ws?user=tabuser%40example.com";

    // Open Tab 1 and wait until streaming (0x02 X.224 Confirm)
    const ws1 = new WebSocket(wsUrl);
    ws1.binaryType = "arraybuffer";
    const ws1Closed = new Promise<CloseEvent>((resolve) => {
      ws1.addEventListener("close", (ev) => resolve(ev));
    });

    await new Promise<void>((resolve, reject) => {
      ws1.addEventListener("open", () => ws1.send(x224RequestFrame));
      ws1.addEventListener("message", (ev) => {
        const bytes = new Uint8Array(ev.data as ArrayBuffer);
        if (bytes[0] === 0x02) resolve();
      });
      ws1.addEventListener("error", () => reject(new Error("ws1 failed")));
    });

    // Open Tab 2 while Tab 1 is still active -> supersedes Tab 1 (4001) and runs pre-connect reset
    const ws2 = new WebSocket(wsUrl);
    ws2.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      ws2.addEventListener("open", () => ws2.send(x224RequestFrame));
      ws2.addEventListener("message", (ev) => {
        const bytes = new Uint8Array(ev.data as ArrayBuffer);
        if (bytes[0] === 0x02) resolve();
      });
      ws2.addEventListener("error", () => reject(new Error("ws2 failed")));
    });

    const closeEv1 = await ws1Closed;
    expect(closeEv1.code).toBe(4001);

    // While ws2 is still active, no post-disconnect sign-out should have killed ws2's session
    await new Promise((r) => setTimeout(r, 50));
    expect(
      terminatedEvents
        .filter((e) => e.username === "tabuser")
        .map((e) => e.reason)
    ).toEqual(["pre-connect", "pre-connect"]);

    // Sending client resize-completed frames (0xFC) while streaming debounces & repositions Plank
    const dimsBytes = new TextEncoder().encode("1440x900");
    const resizeFrame = new Uint8Array(1 + dimsBytes.length);
    resizeFrame[0] = 0xfc;
    resizeFrame.set(dimsBytes, 1);
    ws2.send(resizeFrame);
    ws2.send(resizeFrame);

    for (let i = 0; i < 30; i++) {
      if (repositionedUsers.includes("tabuser")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(repositionedUsers.filter((u) => u === "tabuser")).toEqual(["tabuser"]);

    // Now close Tab 2 -> forced sign-out runs immediately
    ws2.close();
    for (let i = 0; i < 30; i++) {
      if (
        terminatedEvents.some(
          (e) => e.username === "tabuser" && e.reason === "disconnect"
        )
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(
      terminatedEvents
        .filter((e) => e.username === "tabuser")
        .map((e) => e.reason)
    ).toEqual(["pre-connect", "pre-connect", "disconnect"]);
  });

  test("on-connect.sh applies LXQt panel, wallpaper, Plank autostart, and Desktop + Plank shortcuts", async () => {
    const mockAppsDir = path.join(tmpDir, "applications");
    await fs.mkdir(mockAppsDir, { recursive: true });
    for (const appFile of [
      "apigee-user-home.desktop",
      "qterminal.desktop",
      "featherpad.desktop",
      "google-chrome.desktop",
      "codium.desktop",
      "antigravity.desktop",
      "com.anthropic.Claude.desktop",
      "lxqt-config.desktop",
    ]) {
      await fs.writeFile(
        path.join(mockAppsDir, appFile),
        `[Desktop Entry]\nType=Application\nName=Title ${appFile}\nExec=/usr/bin/${appFile.replace(".desktop", "")} %U\nIcon=icon-${appFile}\n[Desktop Action extra]\nName=Action Title\n`
      );
    }
    // Also place Debian's codium-url-handler.desktop (which sorts ASCII-before codium.desktop)
    await fs.writeFile(
      path.join(mockAppsDir, "codium-url-handler.desktop"),
      `[Desktop Entry]\nType=Application\nName=VSCodium - URL Handler\nNoDisplay=true\nExec=/usr/share/codium/codium --open-url %U\nIcon=vscodium\n`
    );

    const cfg = loadConfig({
      SESSION_SECRET: "test-secret",
      DATA_DIR: path.join(tmpDir, "onconnect-data"),
      USERS_FILE: path.join(tmpDir, "onconnect-users.yaml"),
      ON_CONNECT_SCRIPT: path.join(tmpDir, "missing-scripts-dir", "on-connect.sh"),
      NODE_ENV: "test",
    });
    cfg.publicDir = path.join(tmpDir, "missing-public-dir");
    const mgr = new VmUserManager(cfg);

    const freshHome = path.join(tmpDir, "home-alice");
    const fakeSysClaude = path.join(tmpDir, "fake-sys-claude");
    await fs.writeFile(fakeSysClaude, "#!/bin/sh\necho '2.1.323 (Claude Code)'\n", { mode: 0o755 });
    await fs.mkdir(path.join(freshHome, ".local", "bin"), { recursive: true });
    await fs.writeFile(path.join(freshHome, ".local", "bin", "claude"), "#!/bin/sh\necho old\n", {
      mode: 0o755,
    });

    const progressMessages: string[] = [];
    const envOverrides = {
      ON_CONNECT_APPS_DIR: mockAppsDir,
      ON_CONNECT_SKIP_INSTALL: "1",
      ON_CONNECT_SKIP_PROCESS_CHECK: "1",
      ON_CONNECT_CLAUDE_BIN: fakeSysClaude,
    };

    const autostartDir = path.join(freshHome, ".config", "autostart");
    const preExistingDesktopDir = path.join(freshHome, "Desktop");
    const plankAutostartPath = path.join(autostartDir, "plank.desktop");
    await fs.mkdir(autostartDir, { recursive: true });
    await fs.mkdir(preExistingDesktopDir, { recursive: true });
    await fs.writeFile(plankAutostartPath, "[Desktop Entry]\nExec=plank\n");
    await fs.writeFile(path.join(autostartDir, "lxqt-panel.desktop"), "[Desktop Entry]\nHidden=true\n");
    await fs.writeFile(
      path.join(preExistingDesktopDir, "codium-url-handler.desktop"),
      "[Desktop Entry]\nType=Link\nName=VSCodium - URL Handler\n"
    );

    await mgr.runOnConnectHook("alice", {
      homeDirOverride: freshHome,
      envOverrides,
      onProgress: (msg) => progressMessages.push(msg),
    });

    expect(progressMessages.length).toBeGreaterThan(0);

    // Verify stale ~/.local/bin/claude binary was replaced with a symlink to system claude
    const localClaudeStat = await fs.lstat(path.join(freshHome, ".local", "bin", "claude"));
    expect(localClaudeStat.isSymbolicLink()).toBe(true);
    expect(await fs.readlink(path.join(freshHome, ".local", "bin", "claude"))).toBe(fakeSysClaude);

    const panelConfPath = path.join(freshHome, ".config", "lxqt", "panel.conf");
    const pcmanfmConfPath = path.join(freshHome, ".config", "pcmanfm-qt", "lxqt", "settings.conf");
    const userWallpaperPath = path.join(freshHome, ".local", "share", "backgrounds", "wallpaper.jpg");
    const sourceWallpaperStat = await fs.stat(path.resolve("public/wallpaper.jpg"));

    const firstPass = await fs.readFile(panelConfPath, "utf8");
    const pcmanfmConf = await fs.readFile(pcmanfmConfPath, "utf8");
    const wallpaperStat = await fs.stat(userWallpaperPath);

    expect(await Bun.file(path.join(autostartDir, "lxqt-panel.desktop")).exists()).toBe(false);
    expect(await Bun.file(plankAutostartPath).exists()).toBe(false);
    const portalsConf = await fs.readFile(
      path.join(freshHome, ".config", "xdg-desktop-portal", "portals.conf"),
      "utf8"
    );
    expect(portalsConf).toContain("default=gtk");
    expect(firstPass).toContain("panels=panel1");
    expect(firstPass).toContain("plugins=mainmenu, taskbar, spacer, kbindicator, signout");
    expect(firstPass).toContain("menu_file=/etc/xdg/menus/");
    expect(firstPass).toContain("spaceType=invisible");
    expect(firstPass).toContain("[signout]\nalignment=Right\ntype=quicklaunch");
    expect(firstPass).toContain("# [panel2]");

    const tint2Conf = await fs.readFile(path.join(freshHome, ".config", "tint2", "tint2rc"), "utf8");
    expect(tint2Conf).toContain("panel_items = LT");
    expect(tint2Conf).toContain("task_text = 0");
    expect(tint2Conf).toContain("task_icon = 1");
    expect(tint2Conf).toContain("task_thumbnail = 1");
    expect(tint2Conf).toContain("panel_position = bottom center horizontal");
    const sessionConf = await fs.readFile(path.join(freshHome, ".config", "lxqt", "session.conf"), "utf8");
    expect(sessionConf).toContain('layout="us,de,fr,es"');
    expect(tint2Conf).toContain("background_color = #000000 0");
    expect(tint2Conf).toContain("launcher_icon_size = 48");
    expect(tint2Conf).toContain(`launcher_item_app = ${path.join(mockAppsDir, "google-chrome.desktop")}`);
    expect(tint2Conf).toContain(`launcher_item_app = ${path.join(mockAppsDir, "apigee-user-home.desktop")}`);
    expect(tint2Conf).toContain(`launcher_item_app = ${path.join(mockAppsDir, "featherpad.desktop")}`);
    expect(tint2Conf).toContain(`launcher_item_app = ${path.join(mockAppsDir, "antigravity.desktop")}`);
    expect(tint2Conf).toContain(`launcher_item_app = ${path.join(mockAppsDir, "com.anthropic.Claude.desktop")}`);
    expect(tint2Conf).toContain(`launcher_item_app = ${path.join(mockAppsDir, "lxqt-config.desktop")}`);
    expect(await Bun.file(path.join(autostartDir, "tint2.desktop")).exists()).toBe(true);
    expect(wallpaperStat.size).toBe(sourceWallpaperStat.size);
    expect(pcmanfmConf).toContain("QuickExec=true");
    expect(pcmanfmConf).toContain("WallpaperMode=zoom");
    expect(pcmanfmConf).toContain("DesktopShortcuts=Home, Trash");
    const desktopItemsConf = await fs.readFile(
      path.join(freshHome, ".config", "pcmanfm-qt", "lxqt", "desktop-items-0.conf"),
      "utf8"
    );
    expect(desktopItemsConf).toContain("[google-chrome.desktop]\npos=@Point(16 16)");
    expect(desktopItemsConf).toContain("[lxqt-config.desktop]\npos=@Point(16 616)");
    expect(desktopItemsConf).toContain("[Trash]\npos=@Point(16 716)");
    const qtermIni = await fs.readFile(
      path.join(freshHome, ".config", "qterminal.org", "qterminal.ini"),
      "utf8"
    );
    expect(qtermIni).toContain("size=@Size(840 470)");

    const expectedDesktopShortcuts: Array<{
      shortcutFile: string;
      sourceAppFile: string;
      expectedTitle: string;
    }> = [
      {
        shortcutFile: "qterminal.desktop",
        sourceAppFile: "qterminal.desktop",
        expectedTitle: "Terminal",
      },
      {
        shortcutFile: "google-chrome.desktop",
        sourceAppFile: "google-chrome.desktop",
        expectedTitle: "Title google-chrome.desktop",
      },
      {
        shortcutFile: "codium.desktop",
        sourceAppFile: "codium.desktop",
        expectedTitle: "VSCodium",
      },
      {
        shortcutFile: "antigravity.desktop",
        sourceAppFile: "antigravity.desktop",
        expectedTitle: "Antigravity",
      },
      {
        shortcutFile: "claude.desktop",
        sourceAppFile: "com.anthropic.Claude.desktop",
        expectedTitle: "Claude",
      },
      {
        shortcutFile: "lxqt-config.desktop",
        sourceAppFile: "lxqt-config.desktop",
        expectedTitle: "Configuration Center",
      },
    ];

    for (const { shortcutFile, sourceAppFile, expectedTitle } of expectedDesktopShortcuts) {
      const shortcutText = await fs.readFile(
        path.join(freshHome, "Desktop", shortcutFile),
        "utf8"
      );
      expect(shortcutText).toContain("Type=Link");
      expect(shortcutText).toContain(`Name=${expectedTitle}`);
      expect(shortcutText).not.toContain("URL Handler");
      expect(shortcutText).not.toContain("Action Title");
      expect(shortcutText).toContain(`Icon=icon-${sourceAppFile}`);
      expect(shortcutText).toContain(`URL=${path.join(mockAppsDir, sourceAppFile)}`);
    }
    expect(
      await Bun.file(path.join(freshHome, "Desktop", "codium-url-handler.desktop")).exists()
    ).toBe(false);

    // Verify --signout and --reposition-plank invocations succeed cleanly
    for (const flag of ["--signout", "--reposition-plank"] as const) {
      const flagProc = Bun.spawn(
        ["/bin/bash", path.resolve("scripts/on-connect.sh"), flag, "alice"],
        {
          env: { ...process.env, ON_CONNECT_SKIP_PROCESS_CHECK: "1" },
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      expect(await flagProc.exited).toBe(0);
    }

    // Verify Exec= fallback scan skips codium-url-handler.desktop & NoDisplay=true and still names shortcut VSCodium
    const emptyAppsDir = path.join(tmpDir, "empty-applications");
    await fs.mkdir(emptyAppsDir, { recursive: true });
    await fs.writeFile(
      path.join(emptyAppsDir, "codium-url-handler.desktop"),
      `[Desktop Entry]\nType=Application\nName=VSCodium - URL Handler\nNoDisplay=true\nExec=/usr/share/codium/codium --open-url %U\nIcon=vscodium\n`
    );
    await fs.writeFile(
      path.join(emptyAppsDir, "zzz-custom-codium.desktop"),
      `[Desktop Entry]\nType=Application\nName=VSCodium - Insiders\nExec=/usr/share/codium/codium %F\nIcon=vscodium\n`
    );
    const fallbackHome = path.join(tmpDir, "home-bob");
    await mgr.runOnConnectHook("bob", {
      homeDirOverride: fallbackHome,
      envOverrides: {
        ON_CONNECT_APPS_DIR: emptyAppsDir,
        ON_CONNECT_SKIP_INSTALL: "1",
        ON_CONNECT_SKIP_PROCESS_CHECK: "1",
      },
    });
    const bobPanelConf = await fs.readFile(path.join(fallbackHome, ".config", "lxqt", "panel.conf"), "utf8");
    expect(bobPanelConf).toContain("panels=panel1");
    const bobTint2Conf = await fs.readFile(path.join(fallbackHome, ".config", "tint2", "tint2rc"), "utf8");
    expect(bobTint2Conf).toContain("launcher_icon_size = 48");
    const bobCodiumDesktop = await fs.readFile(
      path.join(fallbackHome, "Desktop", "codium.desktop"),
      "utf8"
    );
    expect(bobCodiumDesktop).toContain("Name=VSCodium\n");
    expect(bobCodiumDesktop).toContain(`URL=${path.join(emptyAppsDir, "zzz-custom-codium.desktop")}`);
    expect(bobCodiumDesktop).not.toContain("codium-url-handler.desktop");
    const bobClaudeDesktop = await fs.readFile(
      path.join(fallbackHome, "Desktop", "claude.desktop"),
      "utf8"
    );
    expect(bobClaudeDesktop).toContain("Name=Claude\n");
  });

  test("bootstraps and atomically updates Claude Code system-wide with SHA-256 verification and managed settings", async () => {
    const claudeTestDir = path.join(tmpDir, "claude-bootstrap");
    const claudeBin = path.join(claudeTestDir, "bin", "claude");
    const claudeShareDir = path.join(claudeTestDir, "share");
    const claudeEtcDir = path.join(claudeTestDir, "etc");
    await fs.mkdir(claudeTestDir, { recursive: true });

    let activeVersion = "2.1.320";
    let binaryDownloads = 0;

    const buildReleasePayloads = async (version: string) => {
      const rawBytes = Buffer.from(
        `#!/usr/bin/env bash\necho "${version} (Claude Code)"\n`,
        "utf8"
      );
      const rawSha = crypto.createHash("sha256").update(rawBytes).digest("hex");

      const rawTmp = path.join(claudeTestDir, `payload-${version}`);
      const zstTmp = `${rawTmp}.zst`;
      await fs.writeFile(rawTmp, rawBytes);
      const zstProc = Bun.spawn(["zstd", "-q", "-f", rawTmp, "-o", zstTmp]);
      const zstOk = (await zstProc.exited) === 0;
      const zstBytes = zstOk ? await fs.readFile(zstTmp) : null;
      const zstSha = zstBytes
        ? crypto.createHash("sha256").update(zstBytes).digest("hex")
        : null;

      return { rawBytes, rawSha, zstBytes, zstSha };
    };

    const releases: Record<string, Awaited<ReturnType<typeof buildReleasePayloads>>> = {
      "2.1.320": await buildReleasePayloads("2.1.320"),
      "2.1.323": await buildReleasePayloads("2.1.323"),
    };

    const releaseServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const p = new URL(req.url).pathname;
        if (p === "/latest") {
          return new Response(activeVersion);
        }
        const m = p.match(/^\/([^/]+)\/(.+)$/);
        if (!m) return new Response("Not found", { status: 404 });
        const rel = releases[m[1]!];
        if (!rel) return new Response("Unknown version", { status: 404 });
        const sub = m[2]!;

        if (sub === "manifest.json") {
          return Response.json({
            version: m[1],
            platforms: {
              "darwin-arm64": {
                binary: "claude",
                checksum: "0".repeat(64),
                size: 123,
              },
              "linux-x64": {
                binary: "claude",
                checksum: rel.rawSha,
                size: rel.rawBytes.length,
              },
              "linux-arm64": {
                binary: "claude",
                checksum: rel.rawSha,
                size: rel.rawBytes.length,
              },
            },
          });
        }
        if (sub === "manifest.zst.json" && rel.zstBytes && rel.zstSha) {
          return Response.json({
            version: m[1],
            platforms: {
              "darwin-arm64": {
                binary: "claude.zst",
                checksum: "1".repeat(64),
                size: 100,
                bundle: { checksum: "2".repeat(64), size: 101 },
              },
              "linux-x64": {
                binary: "claude.zst",
                checksum: rel.zstSha,
                size: rel.zstBytes.length,
              },
              "linux-arm64": {
                binary: "claude.zst",
                checksum: rel.zstSha,
                size: rel.zstBytes.length,
              },
            },
          });
        }
        if (sub.endsWith("/claude.zst") && rel.zstBytes) {
          binaryDownloads++;
          return new Response(rel.zstBytes);
        }
        if (sub.endsWith("/claude")) {
          binaryDownloads++;
          return new Response(rel.rawBytes);
        }
        return new Response("Not found", { status: 404 });
      },
    });

    try {
      const runClaudeBootstrap = async () => {
        const proc = Bun.spawn(
          ["/bin/bash", path.resolve("scripts/on-connect.sh"), "--install-claude-code-only"],
          {
            env: {
              ...process.env,
              ON_CONNECT_CLAUDE_BIN: claudeBin,
              ON_CONNECT_CLAUDE_SHARE_DIR: claudeShareDir,
              ON_CONNECT_CLAUDE_ETC_DIR: claudeEtcDir,
              ON_CONNECT_CLAUDE_RELEASES_URL: `http://127.0.0.1:${releaseServer.port}`,
            },
            stdout: "pipe",
            stderr: "pipe",
          }
        );
        const [code, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        expect(code).toBe(0);
        return { stdout, stderr };
      };

      // 1. Fresh install downloads & verifies 2.1.320 and writes managed-settings.json
      const firstRun = await runClaudeBootstrap();
      expect(firstRun.stdout).toContain("Installing Claude Code v2.1.320");
      expect(binaryDownloads).toBe(1);

      const verProc1 = Bun.spawn([claudeBin, "--version"], { stdout: "pipe" });
      expect((await new Response(verProc1.stdout).text()).trim()).toBe("2.1.320 (Claude Code)");
      expect((await fs.readFile(path.join(claudeShareDir, "cli-version"), "utf8")).trim()).toBe(
        "2.1.320"
      );

      const managedSettings = JSON.parse(
        await fs.readFile(path.join(claudeEtcDir, "managed-settings.json"), "utf8")
      );
      expect(managedSettings.env.DISABLE_AUTOUPDATER).toBe("1");

      // 2. Re-running with same version is an instant no-op (no binary download)
      await runClaudeBootstrap();
      expect(binaryDownloads).toBe(1);

      // 3. Publishing 2.1.323 upgrades binary atomically on next bootstrap
      activeVersion = "2.1.323";
      const upgradeRun = await runClaudeBootstrap();
      expect(upgradeRun.stdout).toContain("Installing Claude Code v2.1.323");
      expect(binaryDownloads).toBe(2);

      const verProc2 = Bun.spawn([claudeBin, "--version"], { stdout: "pipe" });
      expect((await new Response(verProc2.stdout).text()).trim()).toBe("2.1.323 (Claude Code)");
    } finally {
      releaseServer.stop(true);
    }
  });

  test("serves continuous host VM CPU/memory telemetry and refuses connections when 5m average CPU >= 70%", async () => {
    // Real HostMetricsMonitor reads /proc/stat & /proc/meminfo cleanly
    const realMonitor = new HostMetricsMonitor(70);
    const realSnap = realMonitor.getSnapshot();
    realMonitor.stop();
    expect(realSnap.memTotalBytes).toBeGreaterThan(0);
    expect(realSnap.cpuCores).toBeGreaterThanOrEqual(1);
    expect(realSnap.cpuAvg5mPercent).toBeGreaterThanOrEqual(0);
    expect(realSnap.cpuAvg5mPercent).toBeLessThanOrEqual(100);

    // 1. Under normal load (< 70%), /api/metrics reports overloaded=false
    simulatedCpu5m = 24.5;
    const metricsRes = await (await fetch(`${baseUrl}/api/metrics`)).json();
    expect(metricsRes.metrics.cpuAvg5mPercent).toBe(24.5);
    expect(metricsRes.metrics.memUsedPercent).toBe(37.5);
    expect(metricsRes.metrics.overloaded).toBe(false);

    const meRes = await fetch(`${baseUrl}/api/me?user=overloadtest@example.com`);
    const cookie = meRes.headers.get("set-cookie")!.split(";")[0]!;
    const meJson = await meRes.json();

    // 2. At exact threshold (70.0%), POST /api/vm-user/ensure refuses with 503 + RESOURCE_BUSY message
    simulatedCpu5m = 70.0;
    const ensureBusyRes = await fetch(
      `${baseUrl}/api/vm-user/ensure?user=overloadtest@example.com`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          "X-CSRF-Token": meJson.csrfToken,
        },
      }
    );
    expect(ensureBusyRes.status).toBe(503);
    const ensureBusy = await ensureBusyRes.json();
    expect(ensureBusy.code).toBe("RESOURCE_BUSY");
    expect(ensureBusy.error).toBe(RESOURCE_BUSY_MESSAGE);

    // 3. Above threshold (83.2%), direct WebSocket connection also refuses with FRAME_ERROR (0xff)
    simulatedCpu5m = 83.2;
    const x224RequestFrame = new Uint8Array([
      0x01,
      0x03, 0x00, 0x00, 0x13,
      0x0e, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x01, 0x00, 0x08, 0x00, 0x01, 0x00, 0x00, 0x00,
    ]);
    const wsUrl =
      baseUrl.replace("http://", "ws://") + "/api/rdp/ws?user=overloadtest%40example.com";
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";

    const errMessage = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for overload error")), 3000);
      ws.addEventListener("open", () => ws.send(x224RequestFrame));
      ws.addEventListener("message", (ev) => {
        const bytes = new Uint8Array(ev.data as ArrayBuffer);
        if (bytes[0] === 0xff) {
          clearTimeout(timer);
          resolve(new TextDecoder().decode(bytes.subarray(1)));
        }
      });
      ws.addEventListener("error", () => reject(new Error("WebSocket error")));
    });

    expect(errMessage).toBe(RESOURCE_BUSY_MESSAGE);
    ws.close();
    simulatedCpu5m = 18.5;
  });
});
