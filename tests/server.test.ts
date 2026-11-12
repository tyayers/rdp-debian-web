import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { deriveLinuxUsername, parseUserIdentity } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";
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

describe("Apigee AI Demos — GCP IAP / ?user= Auth, users.yaml Auto-Provisioning, and IronRDP WASM", () => {
  let tmpDir = "";
  let fakePasswdPath = "";
  let usersYamlPath = "";
  let executedCommands: Array<{ argv: string[]; stdin?: string }> = [];
  let terminatedEvents: Array<{ username: string; reason: "pre-connect" | "disconnect" }> = [];
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
      systemAdapter
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

  test("serves Apigee AI Demos frontend with CSP nonce and defaults usersFile to start directory", async () => {
    const defaultCfg = loadConfig({ NODE_ENV: "test" });
    expect(defaultCfg.usersFile).toBe(path.join(process.cwd(), "users.yaml"));

    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("'wasm-unsafe-eval'");
    const html = await res.text();
    expect(html).toContain("<title>Apigee AI Demos</title>");
    expect(html).not.toContain("{{CSP_NONCE}}");
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
    ]) {
      await fs.writeFile(
        path.join(mockAppsDir, appFile),
        `[Desktop Entry]\nType=Application\nName=Title ${appFile}\nIcon=icon-${appFile}\n[Desktop Action extra]\nName=Action Title\n`
      );
    }

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
    const progressMessages: string[] = [];
    const envOverrides = {
      ON_CONNECT_APPS_DIR: mockAppsDir,
      ON_CONNECT_SKIP_INSTALL: "1",
      ON_CONNECT_SKIP_PROCESS_CHECK: "1",
    };

    const plankDir = path.join(freshHome, ".config", "plank", "dock1", "launchers");
    const autostartDir = path.join(freshHome, ".config", "autostart");
    await fs.mkdir(plankDir, { recursive: true });
    await fs.mkdir(autostartDir, { recursive: true });
    await fs.writeFile(path.join(plankDir, "clock.dockitem"), "[PlankItemsDockItemPreferences]\n");
    await fs.writeFile(path.join(autostartDir, "lxqt-panel.desktop"), "[Desktop Entry]\nHidden=true\n");

    await mgr.runOnConnectHook("alice", {
      homeDirOverride: freshHome,
      envOverrides,
      onProgress: (msg) => progressMessages.push(msg),
    });

    expect(progressMessages.length).toBeGreaterThan(0);

    const panelConfPath = path.join(freshHome, ".config", "lxqt", "panel.conf");
    const pcmanfmConfPath = path.join(freshHome, ".config", "pcmanfm-qt", "lxqt", "settings.conf");
    const userWallpaperPath = path.join(freshHome, ".local", "share", "backgrounds", "wallpaper.jpg");
    const sourceWallpaperStat = await fs.stat(path.resolve("public/wallpaper.jpg"));

    const firstPass = await fs.readFile(panelConfPath, "utf8");
    const pcmanfmConf = await fs.readFile(pcmanfmConfPath, "utf8");
    const wallpaperStat = await fs.stat(userWallpaperPath);

    expect(await Bun.file(path.join(autostartDir, "lxqt-panel.desktop")).exists()).toBe(false);
    const portalsConf = await fs.readFile(
      path.join(freshHome, ".config", "xdg-desktop-portal", "portals.conf"),
      "utf8"
    );
    expect(portalsConf).toContain("default=gtk");
    const plankAutostart = await fs.readFile(path.join(autostartDir, "plank.desktop"), "utf8");
    expect(plankAutostart).toMatch(/Exec=(?:\/usr\/local\/bin\/apigee-start-plank|env NO_AT_BRIDGE=1 GTK_USE_PORTAL=0)/);
    expect(firstPass).toContain("plugins=mainmenu, taskbar, spacer, kbindicator, signout");
    expect(firstPass).toContain("menu_file=/etc/xdg/menus/");
    expect(firstPass).toContain("spaceType=invisible");
    expect(firstPass).toContain("[signout]\nalignment=Right\ntype=quicklaunch");
    expect(wallpaperStat.size).toBe(sourceWallpaperStat.size);
    expect(pcmanfmConf).toContain("QuickExec=true");
    expect(pcmanfmConf).toContain("WallpaperMode=zoom");

    for (const desktopShortcut of [
      "qterminal.desktop",
      "google-chrome.desktop",
      "codium.desktop",
      "antigravity.desktop",
    ]) {
      const shortcutText = await fs.readFile(
        path.join(freshHome, "Desktop", desktopShortcut),
        "utf8"
      );
      expect(shortcutText).toContain("Type=Link");
      expect(shortcutText).toContain(`Name=Title ${desktopShortcut}`);
      expect(shortcutText).not.toContain("Action Title");
      expect(shortcutText).toContain(`Icon=icon-${desktopShortcut}`);
      expect(shortcutText).toContain(`URL=${path.join(mockAppsDir, desktopShortcut)}`);
    }

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
      expect(content).toContain(`Launcher=file://${path.join(mockAppsDir, desktopFile)}`);
    }
    expect(await Bun.file(path.join(plankDir, "clock.dockitem")).exists()).toBe(false);

    // Verify --signout invocation succeeds cleanly
    const signoutProc = Bun.spawn(
      ["/bin/bash", path.resolve("scripts/on-connect.sh"), "--signout", "alice"],
      {
        env: { ...process.env, ON_CONNECT_SKIP_PROCESS_CHECK: "1" },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    expect(await signoutProc.exited).toBe(0);
  });
});
