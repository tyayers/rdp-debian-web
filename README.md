# Apigee AI Demos

Browser-based `xrdp` workstation portal with `@google.com` login, built on **Bun** and **IronRDP (WebAssembly)**.

## Getting Started (Debian VM)

### 1. Prepare `xrdp` on the VM

Make sure `xrdp` can read its TLS key and has a desktop session to launch for newly created users:

```bash
# Allow xrdp to read /etc/xrdp/key.pem for TLS
sudo adduser xrdp ssl-cert
sudo systemctl restart xrdp xrdp-sesman
```

### 2. Configure `.env`

```bash
cp .env.example .env
```

Edit `.env`:

```env
HOST=127.0.0.1
PORT=8080
PUBLIC_BASE_URL=https://your-domain.com
SESSION_SECRET=replace-with-openssl-rand-hex-32

GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret

VM_USER_MODE=system
```

*(In Google Cloud Console, add `https://your-domain.com/api/auth/google/callback` as an Authorized Redirect URI. For `useradd` / `chpasswd` to create users and reset passwords, either run `sudo bun run start` or ensure your VM user has passwordless `sudo`—see `deploy/sudoers.example`.)*

### 3. Configure Caddy

```caddyfile
your-domain.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8080
}
```

### 4. Start the Server

**Option A — Compile a standalone binary and run with `sudo` (Recommended):**

```bash
bun run build
sudo ./apigee-ai-demos
```

*(All HTML, CSS, JS, WASM assets, and the default `scripts/on-connect.sh` hook are embedded into `./apigee-ai-demos`, and it automatically loads `.env` from the current directory—so `sudo` does not need `bun` in `root`'s `PATH`. If `./scripts/on-connect.sh` is present on disk, edits to it take effect immediately on the next RDP connect without recompiling.)*

**Option B — Run directly with Bun:**

```bash
# As a user with passwordless sudo:
bun run start

# Or as root:
sudo "$(which bun)" run start
```

*(For local UI testing without Google OAuth or real Linux users: `ALLOW_DEV_AUTH=true VM_USER_MODE=mock bun run dev`)*

## VM Tool Bootstrap & Per-Connect Desktop Enforcement (`scripts/on-connect.sh`)

- **Installed once system-wide for everyone (`--system-only`)**: On startup (when run via `sudo ./apigee-ai-demos`), the server ensures **Plank**, **QTerminal**, **PCManFM-Qt** (file manager), **FeatherPad** (text editor), **VSCodium** (`codium`), **Google Chrome** (`google-chrome-stable`), and the **current latest releases** of **Antigravity CLI** (`/usr/local/bin/agy`) and **Antigravity IDE** (`/opt/antigravity-ide`) are installed once at the OS level for all users.
- **Applied per user on connect (`./scripts/on-connect.sh <username> <homedir>`)**:
  1. Enforces the top **LXQt** panel layout (`~/.config/lxqt/panel.conf`) and configures **Plank** in `~/.config/autostart/plank.desktop`.
  2. Copies `public/wallpaper.png` into `~/.local/share/backgrounds/wallpaper.png` and sets it as the LXQt desktop background (`~/.config/pcmanfm-qt/lxqt/settings.conf`).
  3. Places shortcuts on `~/Desktop` (**Terminal**, **Google Chrome**, **VSCodium**, **Antigravity IDE**, **Antigravity CLI**) and pins launchers on the **Plank** dock (**File Manager**, **Terminal**, **Text Editor**, **Google Chrome**, **VSCodium**, **Antigravity IDE**, **Antigravity CLI**).

## Troubleshooting Black Screen / Immediate Disconnect

Check the Bun console output and `sudo tail -f /var/log/xrdp.log /var/log/xrdp-sesman.log`:

1. **`VM_USER_MODE=mock` left enabled on the VM**: Mock mode does not create real Linux users or set Linux passwords, so `xrdp-sesman` immediately closes the session after the RDP handshake. Use `VM_USER_MODE=system`.
2. **Desktop session exits immediately (`/etc/xrdp/startwm.sh`)**: On Debian, unset conflicting D-Bus variables before `Xsession` runs in `/etc/xrdp/startwm.sh`:
   ```sh
   unset DBUS_SESSION_BUS_ADDRESS
   unset XDG_RUNTIME_DIR
   ```
   Also ensure a desktop environment (e.g. `xfce4`) is installed and the same Linux user is not already logged into a local graphical session on the VM.
