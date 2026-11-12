import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { deriveLinuxUsername } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";
import { createAppServer } from "../src/server.ts";
import { VmUserManager } from "../src/vm-users.ts";

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

describe("Apigee AI Demos — Auth, VM User Provisioning, and IronRDP WASM Gateway", () => {
  let tmpDir = "";
  let mockRdpServer: net.Server;
  let mockRdpPort = 0;
  let receivedMcsConnectInitial: Buffer | null = null;
  let app: ReturnType<typeof createAppServer>;
  let baseUrl = "";

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "apigee-rdp-test-"));
    const tlsCreds = await generateSelfSignedPem(tmpDir);

    // Mock xrdp server speaking X.224 Connection Request -> Connection Confirm (PROTOCOL_SSL) -> TLS -> MCS
    mockRdpServer = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      const onInitial = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length < 4) return;
        const tpktLen = buf.readUInt16BE(2);
        if (buf.length < tpktLen) return;
        sock.off("data", onInitial);

        const confirm = Buffer.from([
          0x03, 0x00, 0x00, 0x13, // TPKT (length = 19)
          0x0e, // X.224 length indicator (14)
          0xd0, // X.224 Connection Confirm
          0x00, 0x00, // dst-ref
          0x12, 0x34, // src-ref
          0x00, // class 0
          0x02, // RDP_NEG_RSP
          0x00, // flags
          0x08, 0x00, // length = 8
          0x01, 0x00, 0x00, 0x00, // selectedProtocol = PROTOCOL_SSL (1)
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

    app = createAppServer({
      host: "127.0.0.1",
      port: 0,
      sessionSecret: crypto.randomBytes(32).toString("hex"),
      googleClientId: "test-client-id.apps.googleusercontent.com",
      googleClientSecret: "test-client-secret",
      allowedGoogleDomain: "google.com",
      allowDevAuth: true,
      vmUserMode: "mock",
      rdpHost: "127.0.0.1",
      rdpPort: mockRdpPort,
      dataDir: path.join(tmpDir, "data"),
    });
    baseUrl = `http://127.0.0.1:${app.server.port}`;
  });

  afterAll(async () => {
    app?.server.stop(true);
    await new Promise<void>((resolve) => mockRdpServer.close(() => resolve()));
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("serves Apigee AI Demos frontend with CSP nonce and security headers", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("'wasm-unsafe-eval'");
    const html = await res.text();
    expect(html).toContain("<title>Apigee AI Demos</title>");
    expect(html).not.toContain("{{CSP_NONCE}}");

    // Standalone tab route also serves the app shell
    const desktopRes = await fetch(`${baseUrl}/desktop`);
    expect(desktopRes.status).toBe(200);
  });

  test("deriveLinuxUsername enforces @google.com and safe POSIX usernames", () => {
    expect(deriveLinuxUsername("tyayers@google.com", "google.com")).toBe("tyayers");
    expect(deriveLinuxUsername("Jane.Doe@google.com", "google.com")).toBe("jane_doe");
    expect(() => deriveLinuxUsername("user@gmail.com", "google.com")).toThrow();
    expect(() => deriveLinuxUsername("root@google.com", "google.com")).toThrow();
    expect(() => deriveLinuxUsername("xrdp@google.com", "google.com")).toThrow();
  });

  test("system mode detects existing Linux user directly and defaults useSudo when non-root", async () => {
    const cfg = loadConfig({
      SESSION_SECRET: "test-secret",
      VM_USER_MODE: "system",
      DATA_DIR: path.join(tmpDir, "sys-data"),
      NODE_ENV: "test",
    });
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      expect(cfg.useSudo).toBe(true);
    }
    const currentUser = os.userInfo().username;
    if (/^[a-z_][a-z0-9_-]{0,31}$/.test(currentUser) && os.userInfo().uid >= 1000) {
      const sysMgr = new VmUserManager(cfg);
      const status = await sysMgr.getStatus(currentUser);
      expect(status.existsOnSystem).toBe(true);
      expect(status.provisioned).toBe(true);
    }
  });

  test("Google OAuth login endpoint enforces hd=google.com and PKCE S256", async () => {
    const resp = await fetch(`${baseUrl}/api/auth/google/login`, { redirect: "manual" });
    expect(resp.status).toBe(302);
    const location = new URL(resp.headers.get("location")!);
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("hd")).toBe("google.com");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(resp.headers.get("set-cookie")).toContain("HttpOnly");
  });

  test("rejects non-google.com login, enforces CSRF, provisions VM user, and updates password", async () => {
    const badRes = await fetch(`${baseUrl}/api/auth/dev-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "intruder@gmail.com" }),
    });
    expect(badRes.status).toBe(403);

    const crossSite = await fetch(`${baseUrl}/api/auth/dev-login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "cross-site",
      },
      body: JSON.stringify({ email: "demo.user@google.com" }),
    });
    expect(crossSite.status).toBe(403);

    const loginRes = await fetch(`${baseUrl}/api/auth/dev-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "demo.user@google.com" }),
    });
    expect(loginRes.status).toBe(200);
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;

    const meBefore = await (
      await fetch(`${baseUrl}/api/me`, { headers: { Cookie: cookie } })
    ).json();
    expect(meBefore.authenticated).toBe(true);
    expect(meBefore.user.username).toBe("demo_user");
    expect(meBefore.vmUser.provisioned).toBe(false);

    const noCsrf = await fetch(`${baseUrl}/api/vm-user/password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({ password: "StrongPassword123!" }),
    });
    expect(noCsrf.status).toBe(403);

    const setupRes = await fetch(`${baseUrl}/api/vm-user/password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-CSRF-Token": meBefore.csrfToken,
      },
      body: JSON.stringify({ password: "StrongPassword123!" }),
    });
    expect(setupRes.status).toBe(200);
    const setupJson = await setupRes.json();
    expect(setupJson.created).toBe(true);
    expect(setupJson.vmUser.provisioned).toBe(true);

    const updateRes = await fetch(`${baseUrl}/api/vm-user/password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-CSRF-Token": meBefore.csrfToken,
      },
      body: JSON.stringify({ password: "UpdatedPassword456!" }),
    });
    expect(updateRes.status).toBe(200);
    const updateJson = await updateRes.json();
    expect(updateJson.created).toBe(false);
    expect(updateJson.vmUser.provisioned).toBe(true);
  });

  test("IronRDP WASM module + Bun WebSocket proxy completes X.224 + TLS upgrade and sends MCS ConnectInitial", async () => {
    const loginRes = await fetch(`${baseUrl}/api/auth/dev-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "rdp.tester@google.com" }),
    });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
    const me = await (await fetch(`${baseUrl}/api/me`, { headers: { Cookie: cookie } })).json();
    await fetch(`${baseUrl}/api/vm-user/password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-CSRF-Token": me.csrfToken,
      },
      body: JSON.stringify({ password: "TestPassword123!" }),
    });

    // Fetch compiled wasm-bindgen JS + WASM binary served by our Bun server
    const wasmResp = await fetch(`${baseUrl}/wasm/rdp_wasm_bg.wasm`);
    expect(wasmResp.status).toBe(200);
    expect(wasmResp.headers.get("content-type")).toBe("application/wasm");
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

    const wsUrl = baseUrl.replace("http://", "ws://") + "/api/rdp/ws";
    const ws = new WebSocket(wsUrl, { headers: { Cookie: cookie } } as unknown as string[]);
    ws.binaryType = "arraybuffer";

    const session = new wasmJsModule.RdpSession(
      1280,
      800,
      "rdp_tester",
      "TestPassword123!",
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
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for MCS ConnectInitial")), 5000);

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
    ws.close();

    expect(receivedMcsConnectInitial).not.toBeNull();
    expect(receivedMcsConnectInitial![0]).toBe(0x03); // TPKT version 3
    const ascii = receivedMcsConnectInitial!.toString("latin1");
    expect(ascii).toContain("cliprdr");
    expect(ascii).toContain("drdynvc");
  });

  test("on-connect.sh applies LXQt panel, wallpaper, Plank autostart, and Desktop + Plank shortcuts", async () => {
    const mockAppsDir = path.join(tmpDir, "applications");
    await fs.mkdir(mockAppsDir, { recursive: true });
    for (const app of [
      "apigee-user-home.desktop",
      "qterminal.desktop",
      "featherpad.desktop",
      "google-chrome.desktop",
      "codium.desktop",
      "antigravity.desktop",
    ]) {
      await fs.writeFile(path.join(mockAppsDir, app), `[Desktop Entry]\nType=Application\nName=${app}\n`);
    }

    const cfg = loadConfig({
      SESSION_SECRET: "test-secret",
      VM_USER_MODE: "mock",
      DATA_DIR: path.join(tmpDir, "onconnect-data"),
      // Point to missing paths so VmUserManager exercises embedded script + embedded wallpaper fallbacks!
      ON_CONNECT_SCRIPT: path.join(tmpDir, "missing-scripts-dir", "on-connect.sh"),
      NODE_ENV: "test",
    });
    // Also override publicDir to a missing directory to test embedded wallpaper fallback
    cfg.publicDir = path.join(tmpDir, "missing-public-dir");
    const mgr = new VmUserManager(cfg);

    const freshHome = path.join(tmpDir, "home-alice");
    const progressMessages: string[] = [];
    const envOverrides = {
      ON_CONNECT_APPS_DIR: mockAppsDir,
      ON_CONNECT_SKIP_INSTALL: "1",
      ON_CONNECT_SKIP_PROCESS_CHECK: "1",
    };

    // Pre-seed both numbered and unnumbered default Plank dockitems + disabled lxqt-panel override
    const plankDir = path.join(freshHome, ".config", "plank", "dock1", "launchers");
    const autostartDir = path.join(freshHome, ".config", "autostart");
    await fs.mkdir(plankDir, { recursive: true });
    await fs.mkdir(autostartDir, { recursive: true });
    await fs.writeFile(path.join(plankDir, "99-stale-old-item.dockitem"), "[PlankItemsDockItemPreferences]\n");
    await fs.writeFile(path.join(plankDir, "clock.dockitem"), "[PlankItemsDockItemPreferences]\n");
    await fs.writeFile(path.join(autostartDir, "lxqt-panel.desktop"), "[Desktop Entry]\nHidden=true\n");

    await mgr.runOnConnectHook("alice", {
      homeDirOverride: freshHome,
      envOverrides,
      onProgress: (msg) => progressMessages.push(msg),
    });

    expect(progressMessages.length).toBeGreaterThan(0);

    const panelConfPath = path.join(freshHome, ".config", "lxqt", "panel.conf");
    const plankAutostartPath = path.join(freshHome, ".config", "autostart", "plank.desktop");
    const sessionInitAutostartPath = path.join(freshHome, ".config", "autostart", "apigee-session-init.desktop");
    const pcmanfmConfPath = path.join(freshHome, ".config", "pcmanfm-qt", "lxqt", "settings.conf");
    const pcmanfmDefaultConfPath = path.join(freshHome, ".config", "pcmanfm-qt", "default", "settings.conf");
    const userWallpaperPath = path.join(freshHome, ".local", "share", "backgrounds", "wallpaper.jpg");

    const firstPass = await fs.readFile(panelConfPath, "utf8");
    const plankDesktop = await fs.readFile(plankAutostartPath, "utf8");
    const sessionInitDesktop = await fs.readFile(sessionInitAutostartPath, "utf8");
    const pcmanfmConf = await fs.readFile(pcmanfmConfPath, "utf8");
    const pcmanfmDefaultConf = await fs.readFile(pcmanfmDefaultConfPath, "utf8");
    const wallpaperStat = await fs.stat(userWallpaperPath);
    const sourceWallpaperStat = await fs.stat(path.resolve("public/wallpaper.jpg"));

    expect(await Bun.file(path.join(autostartDir, "lxqt-panel.desktop")).exists()).toBe(false);
    expect(firstPass).toContain("[General]\n__userfile__=true\npanels=panel1");
    expect(firstPass).toContain("position=Top");
    expect(firstPass).toContain("plugins=mainmenu, taskbar, spacer, kbindicator, signout");
    expect(firstPass).toContain("menu_file=/etc/xdg/menus/");
    expect(firstPass).toContain("expandable=true");
    expect(firstPass).toContain("[signout]\nalignment=Right\ntype=quicklaunch");
    expect(firstPass).toContain("apigee-signout.desktop");
    expect(plankDesktop).toContain("Exec=plank");
    expect(sessionInitDesktop).toContain("Exec=/usr/local/bin/apigee-session-init");
    expect(wallpaperStat.size).toBe(sourceWallpaperStat.size);
    expect(pcmanfmConf).toContain("QuickExec=true");
    expect(pcmanfmDefaultConf).toContain("QuickExec=true");
    expect(pcmanfmConf).toContain(`Wallpaper=${userWallpaperPath}`);
    expect(pcmanfmConf).toContain("WallpaperMode=zoom");

    // Verify all 4 Desktop shortcuts exist and are executable (0755)
    for (const app of [
      "qterminal.desktop",
      "google-chrome.desktop",
      "codium.desktop",
      "antigravity.desktop",
    ]) {
      const desktopShortcut = path.join(freshHome, "Desktop", app);
      const stat = await fs.stat(desktopShortcut);
      expect(stat.mode & 0o111).toBeGreaterThan(0);
    }

    // Verify exact 6 Plank dockitems exist in ordered sequence and ALL stale/unnumbered items were removed
    const expectedDockItems = [
      ["01-home.dockitem", "apigee-user-home.desktop"],
      ["02-chrome.dockitem", "google-chrome.desktop"],
      ["03-codium.dockitem", "codium.desktop"],
      ["04-terminal.dockitem", "qterminal.desktop"],
      ["05-text-editor.dockitem", "featherpad.desktop"],
      ["06-antigravity.dockitem", "antigravity.desktop"],
    ] as const;

    for (const [dockFile, desktopFile] of expectedDockItems) {
      const content = await fs.readFile(path.join(plankDir, dockFile), "utf8");
      expect(content).toContain("[PlankItemsDockItemPreferences]");
      expect(content).toContain(`Launcher=file://${path.join(mockAppsDir, desktopFile)}`);
    }
    expect(await Bun.file(path.join(plankDir, "99-stale-old-item.dockitem")).exists()).toBe(false);
    expect(await Bun.file(path.join(plankDir, "clock.dockitem")).exists()).toBe(false);

    // Second connect is idempotent
    await mgr.runOnConnectHook("alice", { homeDirOverride: freshHome, envOverrides });
    const secondPass = await fs.readFile(panelConfPath, "utf8");
    const secondPcmanfm = await fs.readFile(pcmanfmConfPath, "utf8");
    expect(secondPass).toBe(firstPass);
    expect(secondPcmanfm).toBe(pcmanfmConf);
  });
});
