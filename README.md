# Apigee AI Demos

Minimalist web portal and browser-based `xrdp` workstation gateway built on **Bun**, **Vanilla HTML/CSS/JS**, and **IronRDP (WebAssembly)**.

All RDP protocol decoding and desktop rendering run client-side in the user's browser via WebAssembly—keeping server memory and CPU overhead minimal on the Debian VM with **no `guacd`, no Java/Tomcat, and no database**.

## Features

- **Google Identity (`@google.com` only)**: OAuth 2.0 / OIDC Authorization Code + PKCE flow restricting sign-in to verified `@google.com` accounts.
- **Automatic Local VM User Provisioning**:
  - Maps `<username>@google.com` to a validated POSIX Linux username (`<username>`).
  - Prompts first-time users to set their local Linux/xrdp password (`useradd` + `chpasswd` over stdin—never stored in plaintext on the server).
  - Allows users to rotate/change their local VM password at any time from the top bar.
  - Supports an optional `SETUP_USER_SCRIPT` hook (`<script> <username> <homedir>`) for customizing home directories on first login.
- **In-App & New-Tab Browser RDP (`xrdp`)**:
  - Connects to the local `xrdp` daemon (`127.0.0.1:3389`) over TLS + PAM autologon, resuming existing Linux sessions seamlessly.
  - Supports embedded workspace viewing, one-click **Open in new tab** (`/desktop`) with live session handoff, dynamic window resize (`DisplayControl`), hardware cursor rendering, `Ctrl+Alt+Del`, fullscreen, and bidirectional text clipboard (`CLIPRDR`).
- **Extensible Shell**: Ready to host additional Apigee AI demo scenarios and documentation links in the left navigation rail.

## Quick Start (Local Development)

For local UI/API testing on a development machine without modifying `/etc/passwd`:

```bash
ALLOW_DEV_AUTH=true VM_USER_MODE=mock bun run dev
```

Open `http://127.0.0.1:8080` and sign in with any `@google.com` test address.

Run the automated test suite (auth, CSRF, VM user provisioning, and end-to-end IronRDP WASM + TLS handshake):

```bash
bun test
```

## Production Deployment on Debian VM (with Caddy & `xrdp`)

### 1. Verify `xrdp` TLS configuration

Ensure `xrdp` is running on `127.0.0.1:3389` with TLS negotiation enabled in `/etc/xrdp/xrdp.ini` (the Debian default):

```ini
[Globals]
security_layer=negotiate
certificate=/etc/xrdp/cert.pem
key_file=/etc/xrdp/key.pem
```

*(Ensure the `xrdp` user can read `/etc/xrdp/key.pem`, e.g. `sudo adduser xrdp ssl-cert && sudo systemctl restart xrdp`.)*

### 2. Configure Google OAuth 2.0 Credentials

1. In Google Cloud Console -> **APIs & Services -> Credentials**, create an **OAuth 2.0 Client ID** (*Web application*).
2. Add the authorized redirect URI:
   ```text
   https://demos.yourdomain.com/api/auth/google/callback
   ```
3. Copy `.env.example` to `.env` and set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_BASE_URL=https://demos.yourdomain.com`, and `SESSION_SECRET` (`openssl rand -hex 32`).

### 3. Run the Bun Service (`systemd`)

Copy this repository to `/opt/apigee-ai-demos` and install [deploy/apigee-ai-demos.service](./deploy/apigee-ai-demos.service):

```bash
sudo cp deploy/apigee-ai-demos.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now apigee-ai-demos
```

*(To run as an unprivileged user instead of `root`, set `USE_SUDO=true` in `.env` and install [deploy/sudoers.example](./deploy/sudoers.example).)*

### 4. Configure Caddy Reverse Proxy

Point Caddy at `127.0.0.1:8080` ([deploy/Caddyfile.example](./deploy/Caddyfile.example)):

```caddyfile
demos.yourdomain.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8080
}
```

Caddy automatically terminates HTTPS, upgrades `/api/rdp/ws` WebSockets (`wss://`), and provides the browser Secure Context needed for clipboard integration.

## Rebuilding the IronRDP WebAssembly Module

`public/wasm/` already includes the compiled release WASM bundle. To rebuild from `wasm/src/lib.rs`:

```bash
bun run build:wasm
```
