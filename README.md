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
USE_SUDO=true   # set false if running bun as root
```

*(In Google Cloud Console, add `https://your-domain.com/api/auth/google/callback` as an Authorized Redirect URI. If running as a non-root user with `USE_SUDO=true`, allow passwordless `/usr/sbin/useradd` and `/usr/sbin/chpasswd` as in `deploy/sudoers.example`.)*

### 3. Configure Caddy

```caddyfile
your-domain.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8080
}
```

### 4. Start the Server

```bash
bun run start
```

*(For local UI testing without Google OAuth or real Linux users: `ALLOW_DEV_AUTH=true VM_USER_MODE=mock bun run dev`)*

## Troubleshooting Black Screen / Immediate Disconnect

Check the Bun console output and `sudo tail -f /var/log/xrdp.log /var/log/xrdp-sesman.log`:

1. **`VM_USER_MODE=mock` left enabled on the VM**: Mock mode does not create real Linux users or set Linux passwords, so `xrdp-sesman` immediately closes the session after the RDP handshake. Use `VM_USER_MODE=system`.
2. **Desktop session exits immediately (`/etc/xrdp/startwm.sh`)**: On Debian, unset conflicting D-Bus variables before `Xsession` runs in `/etc/xrdp/startwm.sh`:
   ```sh
   unset DBUS_SESSION_BUS_ADDRESS
   unset XDG_RUNTIME_DIR
   ```
   Also ensure a desktop environment (e.g. `xfce4`) is installed and the same Linux user is not already logged into a local graphical session on the VM.
