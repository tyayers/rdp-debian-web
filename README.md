# Apigee AI Demos

Browser-based `xrdp` workstation portal authenticated via **Google Cloud IAP** (or `?user=test@example.com` for direct testing), built on **Bun** and **IronRDP (WebAssembly)**.

## How User Provisioning Works

1. **Identity Resolution**:
   - **Behind GCP IAP**: Reads the authenticated user email from the `X-Goog-Authenticated-User-Email` header (e.g. `accounts.google.com:alice@google.com` -> Linux user `alice`).
   - **Direct / Non-IAP Testing**: Pass `?user=test@example.com` in the URL (`http://localhost:8080/?user=test@example.com` -> Linux user `test`).
2. **Automatic Linux User & Password Management (`./users.yaml`)**:
   - Checks `/etc/passwd` on the VM; if the Linux user does not exist yet, creates it automatically (`useradd -m -s /bin/bash`).
   - Generates a random password for the user, stores all usernames and generated passwords in **`./users.yaml`** (in the directory where the service is started, `chmod 600`), syncs the Linux password via `chpasswd`, and **automatically connects** the browser RDP session without any password prompt.
3. **Live Host VM Telemetry & Capacity Guard (`src/host-metrics.ts`)**:
   - Continuously samples host VM `/proc/stat` and `/proc/meminfo` (exposed on `GET /api/metrics` and displayed live in the header bar and sidebar).
   - If the host VM's **5-minute average CPU utilization is ≥ 70%** (configurable via `MAX_CONNECT_CPU_AVG_5M`), new connections are refused with a clear message instructing the user that no free resources are available and to contact the demo owner for assistance.

## Getting Started (Debian 13 VM)

### 1. Prepare `xrdp` on the GCP VM

Make sure `xrdp` can read its TLS key and **GCP OS Login is disabled** on the instance (OS Login intercepts NSS lookups without `/etc/passwd` entries, which blocks local `xrdp` PAM logins):

```bash
# Allow xrdp to read /etc/xrdp/key.pem for TLS
sudo adduser xrdp ssl-cert
sudo systemctl restart xrdp xrdp-sesman
```

*(If GCP OS Login is enabled on the VM, set metadata `enable-oslogin=FALSE` on the instance.)*

### 2. Optional `.env`

```bash
cp .env.example .env
```

```env
HOST=0.0.0.0
PORT=8080
SESSION_SECRET=replace-with-openssl-rand-hex-32
```

### 3. Start the Server

**Option A — Compile a standalone binary and run with `sudo` (Recommended):**

```bash
bun run build
sudo ./apigee-ai-demos
```

*(All HTML, CSS, JS, WASM, `wallpaper.jpg`, and `scripts/on-connect.sh` assets are embedded into `./apigee-ai-demos`. Generated user credentials are saved to `./users.yaml` in the current working directory.)*

**Option B — Run directly with Bun:**

```bash
sudo "$(which bun)" run start
```

Then access via your GCP IAP domain, or directly with `?user=test@example.com`:
`https://your-domain.com/?user=test@example.com`

## VM Tool Bootstrap & Session Lifecycle (`scripts/on-connect.sh`)

- **Installed once system-wide for everyone (`--system-only`)**: On startup as root, the server ensures **Plank**, **QTerminal**, **PCManFM-Qt**, **FeatherPad**, **VSCodium** (`codium`), **Google Chrome** (`google-chrome-stable`), **Claude Code** (`/usr/local/bin/claude`, with `/etc/claude-code/managed-settings.json` disabling per-user background self-updates), **Claude Desktop with Cowork** (`claude-desktop` from Anthropic's official APT repository along with its QEMU/KVM/virtiofsd/bubblewrap sandbox dependencies and `kvm` group membership for VM users), and the **current latest releases** of the **Antigravity 2.0 desktop app** (`/opt/antigravity`), **Antigravity CLI** (`/usr/local/bin/agy`), and **Antigravity IDE** (`/opt/antigravity-ide`) are installed and kept updated at the OS level, and configures `/etc/xrdp/sesman.ini` (`KillDisconnected=true`, `DisconnectedTimeLimit=60`).
- **Fresh sign-in on every connect & forced sign-out on disconnect**:
  - Before opening a new `xrdp` connection, `scripts/on-connect.sh <username> <homedir>` ensures the user belongs to the `kvm` group (when present, for Claude Cowork's local VM sandbox) and terminates any lingering `xrdp` / `LXQt` graphical session for that user first (leaving SSH sessions untouched) so `xrdp-sesman` always performs a clean desktop sign-in.
  - Whenever the user disconnects (closes the browser tab, reloads, clicks **Disconnect**, or signs out), the server immediately runs `scripts/on-connect.sh --signout <username>` to sign out their desktop session.
- **Applied per user on connect (`./scripts/on-connect.sh <username> <homedir>`)**:
  1. Enforces the top **LXQt** panel layout (`~/.config/lxqt/panel.conf`, including explicit `menu_file=/etc/xdg/menus/lxqt-applications.menu` and a right-aligned **Sign Out** button), guarantees `lxqt-panel` and `plank` are running, and marks `~/Desktop/*.desktop` shortcuts trusted.
  2. Copies `public/wallpaper.jpg` into `~/.local/share/backgrounds/wallpaper.jpg` with `WallpaperMode=zoom`.
  3. Places shortcuts on `~/Desktop` (**Terminal**, **Google Chrome**, **VSCodium**, **Antigravity**, **Claude**) and pins launchers on the **Plank** dock (**Home**, **Google Chrome**, **VSCodium**, **Terminal**, **Text Editor**, **Antigravity**, **Claude**).
