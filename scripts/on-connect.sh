#!/usr/bin/env bash
# Apigee AI Demos — VM Bootstrap & Per-Connect User Desktop Enforcement Script
#
# Modes:
#   1) System-wide bootstrap (run once at server startup as root for all users):
#        ./scripts/on-connect.sh --system-only
#   2) Per-user session setup (terminates any stale xrdp session, then prepares fresh configs):
#        ./scripts/on-connect.sh <username> [homedir]
#   3) Force sign-out of a user's xrdp/LXQt desktop session (run on browser disconnect):
#        ./scripts/on-connect.sh --signout <username>
#   4) Restart/reposition Plank dock after dynamic display resize:
#        ./scripts/on-connect.sh --reposition-plank <username>

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_WALLPAPER_SRC="$SCRIPT_DIR/../public/wallpaper.jpg"
WALLPAPER_SRC="${ON_CONNECT_WALLPAPER_SRC:-$DEFAULT_WALLPAPER_SRC}"
APPS_DIR="${ON_CONNECT_APPS_DIR:-/usr/share/applications}"

parse_json_string() {
  local payload="$1"
  local key="$2"
  printf '%s\n' "$payload" | sed -n 's/.*"'"$key"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1
}

parse_claude_platform_field() {
  local json="$1"
  local platform="$2"
  local field="$3"
  json="$(printf '%s' "$json" | tr -d '\n\r\t' | sed 's/  */ /g')"
  if [[ "$field" == "checksum" ]]; then
    if [[ $json =~ \"$platform\"[[:space:]]*:[[:space:]]*[{][^{}]*\"checksum\"[[:space:]]*:[[:space:]]*\"([a-f0-9]{64})\" ]]; then
      printf '%s' "${BASH_REMATCH[1]}"
      return 0
    fi
  elif [[ "$field" == "size" ]]; then
    if [[ $json =~ \"$platform\"[[:space:]]*:[[:space:]]*[{][^{}]*\"size\"[[:space:]]*:[[:space:]]*([0-9]+) ]]; then
      printf '%s' "${BASH_REMATCH[1]}"
      return 0
    fi
  fi
  return 1
}

apt_get() {
  apt-get -o DPkg::Lock::Timeout=120 "$@"
}

ensure_user_in_kvm_group() {
  local target_user="$1"
  [[ "$(id -u)" -ne 0 ]] && return 0
  command -v getent >/dev/null 2>&1 || return 0
  command -v usermod >/dev/null 2>&1 || return 0
  getent group kvm >/dev/null 2>&1 || return 0
  getent passwd -- "$target_user" >/dev/null 2>&1 || return 0
  if ! id -nG -- "$target_user" 2>/dev/null | tr ' ' '\n' | grep -qx 'kvm'; then
    usermod -aG kvm -- "$target_user" 2>/dev/null \
      && echo "[on-connect] Added '$target_user' to 'kvm' group for Claude Cowork VM sandboxing" || true
  fi
}

install_or_update_claude_code() {
  local claude_arch="$1"
  local claude_bin="${ON_CONNECT_CLAUDE_BIN:-/usr/local/bin/claude}"
  local claude_share_dir="${ON_CONNECT_CLAUDE_SHARE_DIR:-/usr/local/share/claude-code}"
  local claude_etc_dir="${ON_CONNECT_CLAUDE_ETC_DIR:-/etc/claude-code}"
  local claude_base_url="${ON_CONNECT_CLAUDE_RELEASES_URL:-https://downloads.claude.ai/claude-code-releases}"
  local claude_install_script_url="${ON_CONNECT_CLAUDE_INSTALL_SCRIPT_URL:-https://claude.ai/install.sh}"

  local claude_platform="linux-${claude_arch}"
  if [[ -f /lib/libc.musl-x86_64.so.1 || -f /lib/libc.musl-aarch64.so.1 ]] || (command -v ldd >/dev/null 2>&1 && ldd /bin/ls 2>&1 | grep -q musl); then
    claude_platform="linux-${claude_arch}-musl"
  fi

  install -d -m 0755 "$(dirname -- "$claude_bin")" "$claude_share_dir" "$claude_etc_dir"

  local claude_ver installed_claude_ver
  claude_ver="$(curl -fsSL --max-time 8 "${claude_base_url}/latest" 2>/dev/null | tr -d '[:space:]' || true)"
  installed_claude_ver="$(cat "${claude_share_dir}/cli-version" 2>/dev/null || true)"

  if [[ "$claude_ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9._-]+)?$ ]] && [[ ! -x "$claude_bin" || "$installed_claude_ver" != "$claude_ver" ]]; then
    echo "[status] Installing Claude Code v${claude_ver}..."
    local claude_manifest claude_sha256 claude_size
    claude_manifest="$(curl -fsSL --max-time 15 "${claude_base_url}/${claude_ver}/manifest.json" 2>/dev/null || true)"
    claude_sha256="$(parse_claude_platform_field "$claude_manifest" "$claude_platform" "checksum" || true)"
    claude_size="$(parse_claude_platform_field "$claude_manifest" "$claude_platform" "size" || true)"

    if [[ "$claude_sha256" =~ ^[a-f0-9]{64}$ ]]; then
      local claude_tmp claude_verified=0
      claude_tmp="$(mktemp -d "${TMPDIR:-/tmp}/claude-code-install.XXXXXX")"

      # Prefer zstd-compressed payload (~3x smaller download) when zstd is available
      if command -v zstd >/dev/null 2>&1 && [[ "$claude_size" =~ ^[1-9][0-9]*$ ]]; then
        local zst_manifest zst_sha256
        zst_manifest="$(curl -fsSL --max-time 15 "${claude_base_url}/${claude_ver}/manifest.zst.json" 2>/dev/null || true)"
        zst_sha256="$(parse_claude_platform_field "$zst_manifest" "$claude_platform" "checksum" || true)"
        if [[ "$zst_sha256" =~ ^[a-f0-9]{64}$ ]] && curl -fsSL -o "$claude_tmp/claude.zst" "${claude_base_url}/${claude_ver}/${claude_platform}/claude.zst"; then
          local actual_zst_sha
          actual_zst_sha="$(sha256sum "$claude_tmp/claude.zst" | cut -d' ' -f1)"
          if [[ "$actual_zst_sha" == "$zst_sha256" ]]; then
            zstd -d -q -c "$claude_tmp/claude.zst" 2>/dev/null | head -c "$claude_size" >"$claude_tmp/claude" || true
            local actual_raw_sha
            actual_raw_sha="$(sha256sum "$claude_tmp/claude" | cut -d' ' -f1)"
            if [[ "$actual_raw_sha" == "$claude_sha256" ]]; then
              claude_verified=1
            fi
          fi
        fi
        rm -f -- "$claude_tmp/claude.zst"
      fi

      if [[ "$claude_verified" -eq 0 ]]; then
        if curl -fsSL -o "$claude_tmp/claude" "${claude_base_url}/${claude_ver}/${claude_platform}/claude"; then
          local actual_sha
          actual_sha="$(sha256sum "$claude_tmp/claude" | cut -d' ' -f1)"
          if [[ "$actual_sha" == "$claude_sha256" ]]; then
            claude_verified=1
          else
            echo "[on-connect] Warning: SHA-256 mismatch for Claude Code v${claude_ver} (${claude_platform})" >&2
          fi
        else
          echo "[on-connect] Warning: failed downloading Claude Code v${claude_ver} (${claude_platform})" >&2
        fi
      fi

      if [[ "$claude_verified" -eq 1 ]]; then
        local claude_stage
        claude_stage="$(dirname -- "$claude_bin")/.claude.tmp.$$"
        cp -f -- "$claude_tmp/claude" "$claude_stage"
        chmod 0755 -- "$claude_stage"
        if [[ "$(id -u)" -eq 0 ]]; then
          chown root:root -- "$claude_stage"
        fi
        mv -f -- "$claude_stage" "$claude_bin"
        printf '%s\n' "$claude_ver" >"${claude_share_dir}/cli-version"
        chmod 0644 "${claude_share_dir}/cli-version"
        echo "[on-connect] Installed Claude Code v${claude_ver} -> ${claude_bin}"
      fi
      rm -rf -- "$claude_tmp"
    else
      echo "[on-connect] Warning: platform ${claude_platform} missing from Claude Code v${claude_ver} manifest" >&2
    fi
  elif [[ ! -x "$claude_bin" ]]; then
    echo "[status] Installing Claude Code..."
    local claude_fallback_home
    claude_fallback_home="$(mktemp -d "${TMPDIR:-/tmp}/claude-code-home.XXXXXX")"
    if curl -fsSL "$claude_install_script_url" | env HOME="$claude_fallback_home" CLAUDE_INSTALL_ALLOW_SUDO=1 bash; then
      if [[ -x "$claude_fallback_home/.local/bin/claude" ]]; then
        local claude_stage
        claude_stage="$(dirname -- "$claude_bin")/.claude.tmp.$$"
        cp -Lf -- "$claude_fallback_home/.local/bin/claude" "$claude_stage"
        chmod 0755 -- "$claude_stage"
        if [[ "$(id -u)" -eq 0 ]]; then
          chown root:root -- "$claude_stage"
        fi
        mv -f -- "$claude_stage" "$claude_bin"
        echo "[on-connect] Installed Claude Code via fallback installer -> ${claude_bin}"
      fi
    else
      echo "[on-connect] Warning: fallback Claude Code installer failed" >&2
    fi
    rm -rf -- "$claude_fallback_home"
  fi

  # Prevent non-root users from failing on self-updates against root-owned /usr/local/bin/claude
  # or duplicating 350MB+ binaries inside every user's home directory
  local managed_settings="${claude_etc_dir}/managed-settings.json"
  if [[ ! -f "$managed_settings" ]]; then
    cat >"$managed_settings" <<'EOF'
{
  "env": {
    "DISABLE_AUTOUPDATER": "1"
  }
}
EOF
    chmod 0644 "$managed_settings"
  fi
}

find_existing_desktop() {
  local cand
  for cand in "$@"; do
    if [[ -f "$APPS_DIR/$cand" ]]; then
      printf '%s' "$cand"
      return 0
    fi
  done
  printf '%s' "${1:-}"
}

resolve_or_create_desktop() {
  local fallback_slug="$1"
  local fallback_title="$2"
  local fallback_exec="$3"
  local fallback_icon="$4"
  shift 4

  local cand
  for cand in "$@"; do
    if [[ -f "$APPS_DIR/$cand" ]]; then
      printf '%s' "$APPS_DIR/$cand"
      return 0
    fi
  done

  # Search installed .desktop files by Exec= binary name in case package renamed its .desktop ID
  # (skipping *-url-handler*.desktop and NoDisplay=true helper entries!)
  local bin_name="${fallback_exec%% *}"
  bin_name="${bin_name##*/}"
  if [[ -n "$bin_name" && -d "$APPS_DIR" ]]; then
    local matched
    while read -r matched; do
      [[ -z "$matched" || ! -f "$matched" ]] && continue
      case "$(basename -- "$matched")" in
        *url-handler*) continue ;;
      esac
      if grep -qE '^NoDisplay=[[:space:]]*true([[:space:]]|$)' "$matched" 2>/dev/null; then
        continue
      fi
      printf '%s' "$matched"
      return 0
    done < <(grep -lE "^Exec=([^[:space:]]*/)?${bin_name}([[:space:]]|\$)" "$APPS_DIR"/*.desktop 2>/dev/null || true)
  fi

  # Guaranteed fallback .desktop in user applications dir so Plank never drops an icon
  local fallback_path="$USER_APPS_DIR/apigee-${fallback_slug}.desktop"
  write_user_file "$fallback_path" 0644 <<EOF || true
[Desktop Entry]
Version=1.0
Type=Application
Name=$fallback_title
Exec=$fallback_exec
Icon=$fallback_icon
Terminal=false
StartupNotify=true
EOF
  printf '%s' "$fallback_path"
}

# ---------------------------------------------------------------------------
# 1. System-wide tool installation (installed ONCE on the VM for all users)
# ---------------------------------------------------------------------------
install_or_update_system_tools() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "[on-connect] Warning: not running as root; skipping system package checks" >&2
    return 0
  fi

  export DEBIAN_FRONTEND=noninteractive

  local uname_m deb_arch cli_arch claude_arch app_platform
  uname_m="$(uname -m)"
  deb_arch="$(dpkg --print-architecture 2>/dev/null || echo amd64)"
  case "$uname_m" in
    x86_64|amd64)
      cli_arch="amd64"
      claude_arch="x64"
      app_platform="linux-x64"
      ;;
    aarch64|arm64)
      cli_arch="arm64"
      claude_arch="arm64"
      app_platform="linux-arm"
      ;;
    *)
      cli_arch="amd64"
      claude_arch="x64"
      app_platform="linux-x64"
      ;;
  esac

  # 1a. Base desktop packages: QTerminal, PCManFM-Qt, FeatherPad, LXQt panel/session/menu data, Adwaita icons, GIO/GVFS, zstd, XDG utils & GTK portal
  local missing_base=0
  local cmd
  for cmd in curl gpg zstd xdg-open update-desktop-database lxqt-panel picom qterminal pcmanfm-qt featherpad lxqt-leave gio dbus-update-activation-environment; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing_base=1
      break
    fi
  done
  if [[ ! -f /etc/xdg/menus/lxqt-applications.menu || ! -f /usr/share/xdg-desktop-portal/portals/gtk.portal || ! -f /usr/share/icons/Adwaita/index.theme ]] || ! dpkg -s librsvg2-common >/dev/null 2>&1; then
    missing_base=1
  fi
  if [[ "$missing_base" -eq 1 ]]; then
    echo "[status] Installing LXQt desktop, Terminal, Text Editor & desktop utilities..."
    apt_get update -qq
    apt_get install -y -qq --no-install-recommends \
      ca-certificates curl gpg zstd xdg-utils desktop-file-utils \
      adwaita-icon-theme librsvg2-common picom qterminal pcmanfm-qt featherpad \
      lxqt-menu-data lxqt-panel lxqt-session libglib2.0-bin gvfs \
      dbus-x11 xdg-desktop-portal xdg-desktop-portal-gtk
  fi

  # 1b. VSCodium (codium)
  if ! command -v codium >/dev/null 2>&1; then
    echo "[status] Installing VSCodium..."
    install -d -m 0755 /usr/share/keyrings
    curl -fsSL https://gitlab.com/paulcarroty/vscodium-deb-rpm-repo/raw/master/pub.gpg \
      | gpg --dearmor --yes -o /usr/share/keyrings/vscodium-archive-keyring.gpg
    chmod 0644 /usr/share/keyrings/vscodium-archive-keyring.gpg
    cat >/etc/apt/sources.list.d/vscodium.sources <<'EOF'
Types: deb
URIs: https://download.vscodium.com/debs
Suites: vscodium
Components: main
Architectures: amd64 arm64
Signed-by: /usr/share/keyrings/vscodium-archive-keyring.gpg
EOF
    apt_get update -qq
    apt_get install -y -qq codium
  fi

  # 1c. Google Chrome (google-chrome-stable on amd64; chromium fallback on arm64)
  if ! command -v google-chrome-stable >/dev/null 2>&1 && ! command -v google-chrome >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1; then
    echo "[status] Installing Google Chrome..."
    if [[ "$deb_arch" == "amd64" ]]; then
      install -d -m 0755 /etc/apt/keyrings
      curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor --yes -o /etc/apt/keyrings/google-chrome.gpg
      chmod 0644 /etc/apt/keyrings/google-chrome.gpg
      echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
        >/etc/apt/sources.list.d/google-chrome.list
      apt_get update -qq
      apt_get install -y -qq google-chrome-stable
    else
      apt_get update -qq
      apt_get install -y -qq chromium
    fi
  fi

  install -d -m 0755 \
    /usr/local/bin \
    /usr/local/share/antigravity \
    /usr/local/share/claude-code \
    /etc/claude-code \
    /usr/share/pixmaps \
    /usr/share/icons/hicolor/256x256/apps \
    /usr/share/applications \
    /usr/share/backgrounds

  # Shared official Antigravity icon (installed into both pixmaps and hicolor theme for QIcon::fromTheme)
  if [[ ! -s /usr/share/pixmaps/antigravity.png ]]; then
    curl -fsSL --max-time 8 -o /usr/share/pixmaps/antigravity.png \
      "https://antigravity.google/assets/image/antigravity-logo.png" 2>/dev/null || true
    [[ -f /usr/share/pixmaps/antigravity.png ]] && chmod 0644 /usr/share/pixmaps/antigravity.png
  fi
  if [[ -s /usr/share/pixmaps/antigravity.png ]]; then
    install -m 0644 /usr/share/pixmaps/antigravity.png /usr/share/icons/hicolor/256x256/apps/antigravity.png
    command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -f -t /usr/share/icons/hicolor 2>/dev/null || true
  fi

  # 1d. Antigravity 2.0 Desktop App (current latest release from antigravity-hub)
  local hub_releases first_hub hub_ver hub_exec_id hub_release_id installed_hub_id
  hub_releases="$(curl -fsSL --max-time 8 "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/releases" 2>/dev/null || true)"
  first_hub="$(printf '%s' "$hub_releases" | tr '}' '\n' | head -n1)"
  hub_ver="$(parse_json_string "$first_hub" "version")"
  hub_exec_id="$(parse_json_string "$first_hub" "execution_id")"
  hub_release_id=""
  if [[ -n "$hub_ver" && -n "$hub_exec_id" ]]; then
    hub_release_id="${hub_ver}-${hub_exec_id}"
  fi
  installed_hub_id="$(cat /opt/antigravity/.release-id 2>/dev/null || true)"

  if [[ -n "$hub_release_id" ]] && [[ ! -x /opt/antigravity/antigravity || "$installed_hub_id" != "$hub_release_id" ]]; then
    echo "[status] Installing Antigravity v${hub_ver}..."
    local hub_url hub_tmp hub_stage
    hub_url="https://storage.googleapis.com/antigravity-public/antigravity-hub/${hub_release_id}/${app_platform}/Antigravity.tar.gz"
    hub_tmp="$(mktemp /tmp/antigravity-app.XXXXXX.tar.gz)"
    hub_stage="/opt/antigravity.tmp.$$"
    rm -rf -- "$hub_stage"
    mkdir -p -- "$hub_stage"

    if curl -fsSL -o "$hub_tmp" "$hub_url" && tar -xzf "$hub_tmp" -C "$hub_stage" --strip-components=1; then
      if [[ -f "$hub_stage/chrome-sandbox" ]]; then
        chown root:root "$hub_stage/chrome-sandbox"
        chmod 4755 "$hub_stage/chrome-sandbox"
      fi
      printf '%s\n' "$hub_release_id" >"$hub_stage/.release-id"
      rm -rf /opt/antigravity
      mv -- "$hub_stage" /opt/antigravity
      ln -sf /opt/antigravity/antigravity /usr/local/bin/antigravity
      echo "[on-connect] Installed Antigravity v${hub_ver} (${hub_release_id}) -> /opt/antigravity"
    else
      echo "[on-connect] Warning: failed downloading or extracting Antigravity from $hub_url" >&2
      rm -rf -- "$hub_stage"
    fi
    rm -f -- "$hub_tmp"
  fi

  if [[ -x /opt/antigravity/antigravity ]]; then
    if [[ ! -s /usr/share/pixmaps/antigravity.png && -f /opt/antigravity/resources/app/resources/linux/code.png ]]; then
      install -m 0644 /opt/antigravity/resources/app/resources/linux/code.png /usr/share/pixmaps/antigravity.png
      install -m 0644 /usr/share/pixmaps/antigravity.png /usr/share/icons/hicolor/256x256/apps/antigravity.png
      command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -f -t /usr/share/icons/hicolor 2>/dev/null || true
    fi
    local app_icon="applications-development"
    if [[ -s /usr/share/pixmaps/antigravity.png ]]; then
      app_icon="antigravity"
    fi
    cat >/usr/share/applications/antigravity.desktop <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=Antigravity
Comment=Google Antigravity Desktop Application
Exec=/opt/antigravity/antigravity %U
Icon=$app_icon
Terminal=false
StartupNotify=true
StartupWMClass=Antigravity
Categories=Development;Utility;
EOF
    chmod 0644 /usr/share/applications/antigravity.desktop
  fi

  # 1e. Antigravity CLI (current latest release installed to /usr/local/bin/agy for terminal use)
  local cli_manifest cli_ver cli_url cli_sha512 installed_cli_ver
  cli_manifest="$(curl -fsSL --max-time 8 "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_${cli_arch}.json" 2>/dev/null || true)"
  cli_ver="$(parse_json_string "$cli_manifest" "version")"
  cli_url="$(parse_json_string "$cli_manifest" "url")"
  cli_sha512="$(parse_json_string "$cli_manifest" "sha512")"
  installed_cli_ver="$(cat /usr/local/share/antigravity/cli-version 2>/dev/null || true)"

  if [[ -n "$cli_ver" && -n "$cli_url" && -n "$cli_sha512" ]] && [[ ! -x /usr/local/bin/agy || "$installed_cli_ver" != "$cli_ver" ]]; then
    echo "[status] Installing Antigravity CLI v${cli_ver}..."
    local cli_tmp
    cli_tmp="$(mktemp -d /tmp/agy-cli-install.XXXXXX)"
    if curl -fsSL -o "$cli_tmp/payload" "$cli_url"; then
      local actual_sha
      actual_sha="$(sha512sum "$cli_tmp/payload" | cut -d' ' -f1)"
      if [[ "$actual_sha" == "$cli_sha512" ]]; then
        if [[ "$cli_url" == *.tar.gz* ]]; then
          tar -xzf "$cli_tmp/payload" -C "$cli_tmp" antigravity
          install -m 0755 "$cli_tmp/antigravity" /usr/local/bin/agy
        else
          install -m 0755 "$cli_tmp/payload" /usr/local/bin/agy
        fi
        printf '%s\n' "$cli_ver" >/usr/local/share/antigravity/cli-version
        echo "[on-connect] Installed Antigravity CLI v${cli_ver} -> /usr/local/bin/agy"
      else
        echo "[on-connect] Warning: SHA-512 mismatch for Antigravity CLI payload" >&2
      fi
    fi
    rm -rf -- "$cli_tmp"
  elif [[ ! -x /usr/local/bin/agy ]]; then
    echo "[status] Installing Antigravity CLI..."
    curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /usr/local/bin || true
  fi

  # 1f. Antigravity IDE (kept up-to-date in /opt/antigravity-ide)
  local ide_releases first_release ide_ver ide_exec_id ide_release_id installed_ide_id
  ide_releases="$(curl -fsSL --max-time 8 "https://antigravity-ide-auto-updater-974169037036.us-central1.run.app/releases" 2>/dev/null || true)"
  first_release="$(printf '%s' "$ide_releases" | tr '}' '\n' | head -n1)"
  ide_ver="$(parse_json_string "$first_release" "version")"
  ide_exec_id="$(parse_json_string "$first_release" "execution_id")"
  ide_release_id=""
  if [[ -n "$ide_ver" && -n "$ide_exec_id" ]]; then
    ide_release_id="${ide_ver}-${ide_exec_id}"
  fi
  installed_ide_id="$(cat /opt/antigravity-ide/.release-id 2>/dev/null || true)"

  if [[ -n "$ide_release_id" ]] && [[ ! -x /opt/antigravity-ide/antigravity-ide || "$installed_ide_id" != "$ide_release_id" ]]; then
    echo "[status] Installing Antigravity IDE v${ide_ver}..."
    local ide_url ide_tmp ide_stage
    ide_url="https://edgedl.me.gvt1.com/edgedl/release2/j0qc3/antigravity/stable/${ide_release_id}/${app_platform}/Antigravity%20IDE.tar.gz"
    ide_tmp="$(mktemp /tmp/antigravity-ide.XXXXXX.tar.gz)"
    ide_stage="/opt/antigravity-ide.tmp.$$"
    rm -rf -- "$ide_stage"
    mkdir -p -- "$ide_stage"

    if curl -fsSL -o "$ide_tmp" "$ide_url" && tar -xzf "$ide_tmp" -C "$ide_stage" --strip-components=1; then
      if [[ -f "$ide_stage/chrome-sandbox" ]]; then
        chown root:root "$ide_stage/chrome-sandbox"
        chmod 4755 "$ide_stage/chrome-sandbox"
      fi
      printf '%s\n' "$ide_release_id" >"$ide_stage/.release-id"
      rm -rf /opt/antigravity-ide
      mv -- "$ide_stage" /opt/antigravity-ide
      ln -sf /opt/antigravity-ide/bin/antigravity-ide /usr/local/bin/antigravity-ide
      if [[ -f /opt/antigravity-ide/resources/app/resources/linux/code.png ]]; then
        cp -f /opt/antigravity-ide/resources/app/resources/linux/code.png /usr/share/pixmaps/antigravity-ide.png
        chmod 0644 /usr/share/pixmaps/antigravity-ide.png
      fi
      echo "[on-connect] Installed Antigravity IDE v${ide_ver} (${ide_release_id}) -> /opt/antigravity-ide"
    else
      echo "[on-connect] Warning: failed downloading or extracting Antigravity IDE from $ide_url" >&2
      rm -rf -- "$ide_stage"
    fi
    rm -f -- "$ide_tmp"
  fi

  if [[ -x /opt/antigravity-ide/antigravity-ide ]]; then
    local ide_icon="text-editor"
    if [[ -s /usr/share/pixmaps/antigravity-ide.png ]]; then
      ide_icon="/usr/share/pixmaps/antigravity-ide.png"
    fi
    cat >/usr/share/applications/antigravity-ide.desktop <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=Antigravity IDE
Comment=Google Antigravity AI-First IDE
Exec=/opt/antigravity-ide/antigravity-ide %F
Icon=$ide_icon
Terminal=false
StartupNotify=true
StartupWMClass=Antigravity IDE
Categories=Development;IDE;TextEditor;
EOF
    chmod 0644 /usr/share/applications/antigravity-ide.desktop
  fi

  # 1g. Claude Code CLI (installed globally at /usr/local/bin/claude for all users)
  install_or_update_claude_code "$claude_arch"

  # 1h. Claude Desktop & Cowork (installed from Anthropic's official APT repository for all users)
  if [[ "$deb_arch" == "amd64" || "$deb_arch" == "arm64" ]]; then
    local claude_keyring="/usr/share/keyrings/claude-desktop-archive-keyring.asc"
    local claude_sources="/etc/apt/sources.list.d/claude-desktop.list"
    local claude_key_url="${ON_CONNECT_CLAUDE_DESKTOP_KEY_URL:-https://downloads.claude.ai/claude-desktop/key.asc}"
    local claude_apt_url="${ON_CONNECT_CLAUDE_DESKTOP_APT_URL:-https://downloads.claude.ai/claude-desktop/apt/stable}"

    if ! command -v claude-desktop >/dev/null 2>&1 || [[ "${ON_CONNECT_SYSTEM_BOOTSTRAP:-0}" == "1" ]]; then
      install -d -m 0755 /usr/share/keyrings /etc/apt/sources.list.d
      if [[ ! -s "$claude_keyring" ]]; then
        if curl -fsSL --max-time 15 -o "${claude_keyring}.tmp.$$" "$claude_key_url"; then
          chmod 0644 "${claude_keyring}.tmp.$$"
          mv -f -- "${claude_keyring}.tmp.$$" "$claude_keyring"
        else
          rm -f -- "${claude_keyring}.tmp.$$"
          echo "[on-connect] Warning: failed downloading Claude Desktop PGP key from $claude_key_url" >&2
        fi
      fi

      if [[ -s "$claude_keyring" && ! -f "$claude_sources" ]]; then
        cat >"$claude_sources" <<EOF
### Managed by the claude-desktop package.
### Set CLAUDE_DESKTOP_ADD_REPO="true"|"false" in /etc/default/claude-desktop
### to force this entry on or off; remove this file too when opting out.
deb [arch=amd64,arm64 signed-by=/usr/share/keyrings/claude-desktop-archive-keyring.asc] ${claude_apt_url} stable main
EOF
        chmod 0644 "$claude_sources"
      fi

      if [[ -s "$claude_keyring" && -f "$claude_sources" ]]; then
        if ! command -v claude-desktop >/dev/null 2>&1; then
          echo "[status] Installing Claude Desktop (Cowork)..."
          if apt_get update -qq && apt_get install -y -qq --install-recommends claude-desktop; then
            echo "[on-connect] Installed Claude Desktop (with Cowork VM/sandbox dependencies)"
          else
            echo "[on-connect] Warning: failed installing claude-desktop via APT" >&2
          fi
        elif [[ "${ON_CONNECT_SYSTEM_BOOTSTRAP:-0}" == "1" ]]; then
          # On root service startup, refresh Anthropic's APT repo and upgrade claude-desktop if newer
          if (apt_get update -qq -o Dir::Etc::sourcelist="sources.list.d/claude-desktop.list" -o Dir::Etc::sourceparts="-" -o Acquire::Languages="none" 2>/dev/null || apt_get update -qq) \
            && apt_get install -y -qq --install-recommends claude-desktop; then
            echo "[on-connect] Verified/updated Claude Desktop (Cowork)"
          else
            echo "[on-connect] Warning: failed checking Claude Desktop APT updates" >&2
          fi
        fi
      fi
    fi

    if [[ -s /usr/share/icons/hicolor/256x256/apps/claude-desktop.png && ! -s /usr/share/pixmaps/claude-desktop.png ]]; then
      install -m 0644 /usr/share/icons/hicolor/256x256/apps/claude-desktop.png /usr/share/pixmaps/claude-desktop.png
      command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -f -t /usr/share/icons/hicolor 2>/dev/null || true
    fi

    # Ensure existing local VM accounts can access /dev/kvm for Claude Cowork's QEMU/KVM sandbox
    if command -v getent >/dev/null 2>&1 && getent group kvm >/dev/null 2>&1 && [[ -r /etc/passwd ]]; then
      local pw_user pw_uid pw_shell
      while IFS=: read -r pw_user _ pw_uid _ _ _ pw_shell; do
        [[ "$pw_uid" =~ ^[0-9]+$ ]] || continue
        if (( pw_uid >= 1000 && pw_uid < 60000 )); then
          case "$pw_shell" in
            */nologin|*/false|/bin/sync) continue ;;
          esac
          ensure_user_in_kvm_group "$pw_user"
        fi
      done </etc/passwd
    fi
  fi

  # Refresh desktop MIME & icon caches so all installed apps and icons resolve immediately on first login
  if command -v update-desktop-database >/dev/null 2>&1 && [[ -d /usr/share/applications ]]; then
    update-desktop-database -q /usr/share/applications 2>/dev/null || true
  fi
  if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    for icon_dir in /usr/share/icons/hicolor /usr/share/icons/Adwaita; do
      [[ -f "$icon_dir/index.theme" ]] && gtk-update-icon-cache -q -f -t "$icon_dir" 2>/dev/null || true
    done
  fi

  # 1i. Shared "Home" launcher (Plank dock) & "Sign Out" launcher (LXQt top panel right side)
  cat >/usr/share/applications/apigee-user-home.desktop <<'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Home
Comment=Open Home Folder
Exec=sh -c 'exec pcmanfm-qt "$HOME"'
Icon=user-home
Terminal=false
NoDisplay=true
Categories=System;FileManager;
EOF
  chmod 0644 /usr/share/applications/apigee-user-home.desktop

  cat >/usr/share/applications/apigee-signout.desktop <<'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Sign Out
Comment=Sign out of desktop session
Exec=lxqt-leave --logout
Icon=system-log-out
Terminal=false
NoDisplay=true
Categories=System;
EOF
  chmod 0644 /usr/share/applications/apigee-signout.desktop

  # 1j. Clean up any legacy Plank startup/dconf files and install LXQt session init helper
  rm -f /usr/local/bin/apigee-start-plank \
    /etc/dconf/db/local.d/00-apigee-plank \
    /etc/dconf/db/local.d/locks/00-apigee-plank
  if command -v dconf >/dev/null 2>&1; then
    dconf update 2>/dev/null || true
  fi

  cat >/usr/local/bin/apigee-session-init <<'EOF'
#!/usr/bin/env bash
# Runs inside the user's active LXQt D-Bus/X11 session on login
export XDG_CURRENT_DESKTOP="${XDG_CURRENT_DESKTOP:-LXQt}"
export XDG_MENU_PREFIX="${XDG_MENU_PREFIX:-lxqt-}"
export XDG_SESSION_TYPE="${XDG_SESSION_TYPE:-x11}"

if [[ -n "${DISPLAY:-}" ]] && command -v dbus-update-activation-environment >/dev/null 2>&1; then
  dbus-update-activation-environment --systemd DISPLAY XAUTHORITY XDG_CURRENT_DESKTOP XDG_SESSION_TYPE 2>/dev/null \
    || dbus-update-activation-environment DISPLAY XAUTHORITY XDG_CURRENT_DESKTOP XDG_SESSION_TYPE 2>/dev/null || true
fi

apply_trust() {
  # Mark any ~/Desktop/*.desktop files trusted in GVFS (LXQt libfm-qt uses 'metadata::trust')
  if command -v gio >/dev/null 2>&1 && [[ -d "$HOME/Desktop" ]]; then
    for f in "$HOME/Desktop"/*.desktop; do
      [[ -f "$f" ]] || continue
      gio set -t string "$f" metadata::trust true 2>/dev/null || true
      gio set -t string "$f" metadata::trusted true 2>/dev/null || true
    done
  fi
}

ensure_panel_running() {
  if command -v picom >/dev/null 2>&1 && ! pgrep -u "$(id -u)" -x picom >/dev/null 2>&1; then
    nohup picom --backend xrender --no-fading-openclose </dev/null >/dev/null 2>&1 &
  fi
  if command -v lxqt-panel >/dev/null 2>&1 && ! pgrep -u "$(id -u)" -x lxqt-panel >/dev/null 2>&1; then
    nohup lxqt-panel </dev/null >/dev/null 2>&1 &
  fi
}

apply_trust
if [[ "${1:-}" == "--Immediate" ]]; then
  ensure_panel_running
else
  (
    sleep 2
    apply_trust
    ensure_panel_running
  ) </dev/null >/dev/null 2>&1 &
fi
EOF
  chmod 0755 /usr/local/bin/apigee-session-init

  # Stage shared copy of wallpaper in /usr/share/backgrounds as well
  if [[ -f "$WALLPAPER_SRC" ]]; then
    install -m 0644 "$WALLPAPER_SRC" /usr/share/backgrounds/apigee-wallpaper.jpg
    rm -f /usr/share/backgrounds/apigee-wallpaper.png
  fi

  # 1i. Configure xrdp-sesman (/etc/xrdp/sesman.ini) to reap disconnected sessions automatically
  local sesman_ini="${ON_CONNECT_SESMAN_INI:-/etc/xrdp/sesman.ini}"
  if [[ -f "$sesman_ini" ]]; then
    local sesman_tmp
    sesman_tmp="$(mktemp "${TMPDIR:-/tmp}/sesman-ini.XXXXXX")"
    awk '
      BEGIN {
        sec = ""
        saw_sessions = 0
        set_kill = 0
        set_limit = 0
      }
      function flush_sessions() {
        if (sec == "Sessions") {
          if (!set_kill) { print "KillDisconnected=true"; set_kill = 1 }
          if (!set_limit) { print "DisconnectedTimeLimit=60"; set_limit = 1 }
        }
      }
      /^\[[^]]+\][ \t]*$/ {
        flush_sessions()
        sec = $0
        sub(/^\[/, "", sec)
        sub(/\][ \t]*$/, "", sec)
        if (sec == "Sessions") saw_sessions = 1
        print $0
        next
      }
      {
        if (sec == "Sessions") {
          if ($0 ~ /^[#; \t]*KillDisconnected=/) {
            if (!set_kill) {
              print "KillDisconnected=true"
              set_kill = 1
            }
            next
          }
          if ($0 ~ /^[#; \t]*DisconnectedTimeLimit=/) {
            if (!set_limit) {
              print "DisconnectedTimeLimit=60"
              set_limit = 1
            }
            next
          }
        }
        print $0
      }
      END {
        flush_sessions()
        if (!saw_sessions) {
          print ""
          print "[Sessions]"
          print "KillDisconnected=true"
          print "DisconnectedTimeLimit=60"
        }
      }
    ' "$sesman_ini" >"$sesman_tmp"

    if ! cmp -s "$sesman_tmp" "$sesman_ini"; then
      chmod 0644 "$sesman_tmp"
      mv -f -- "$sesman_tmp" "$sesman_ini"
      echo "[on-connect] Updated $sesman_ini (KillDisconnected=true, DisconnectedTimeLimit=60)"
      pkill -HUP -x xrdp-sesman 2>/dev/null || systemctl reload xrdp-sesman 2>/dev/null || true
    else
      rm -f -- "$sesman_tmp"
    fi
  fi
}

run_serialized_system_install() {
  if [[ "${ON_CONNECT_SKIP_INSTALL:-0}" == "1" ]]; then
    return 0
  fi
  if [[ "$(id -u)" -eq 0 ]] && command -v flock >/dev/null 2>&1; then
    (
      flock -x 9
      install_or_update_system_tools
    ) 9>/var/lock/apigee-ai-demos-install.lock
  else
    install_or_update_system_tools
  fi
}

# ---------------------------------------------------------------------------
# Per-user xrdp / LXQt desktop session sign-out helper (never touches sshd)
# ---------------------------------------------------------------------------
list_user_xrdp_logind_sessions() {
  local target_user="$1"
  local target_uid="$2"
  command -v loginctl >/dev/null 2>&1 || return 0

  local sid s_name s_user s_service s_type
  while read -r sid _; do
    [[ -z "$sid" ]] && continue
    s_name=""
    s_user=""
    s_service=""
    s_type=""
    while IFS='=' read -r k v; do
      case "$k" in
        Name) s_name="$v" ;;
        User) s_user="$v" ;;
        Service) s_service="$v" ;;
        Type) s_type="$v" ;;
      esac
    done < <(loginctl show-session "$sid" -p Name -p User -p Service -p Type 2>/dev/null || true)

    if [[ "$s_name" == "$target_user" || "$s_user" == "$target_uid" ]]; then
      if [[ "$s_service" == "xrdp-sesman" || "$s_type" == "x11" || "$s_type" == "wayland" ]]; then
        printf '%s\n' "$sid"
      fi
    fi
  done < <(loginctl list-sessions --no-legend 2>/dev/null || true)
}

list_user_xrdp_pids() {
  local target_uid="$1"
  command -v pgrep >/dev/null 2>&1 || return 0
  [[ -z "$target_uid" || "$target_uid" -lt 1000 ]] && return 0

  local pid comm
  while read -r pid; do
    [[ -z "$pid" || "$pid" == "$$" ]] && continue
    comm=""
    read -r comm <"/proc/$pid/comm" 2>/dev/null || true
    case "$comm" in
      lxqt-session|lxqt-panel|pcmanfm-qt|picom|plank|bamfdaemon|xdg-desktop-por|openbox|xfwm4|xrdp-chansrv|Xorg|Xvnc)
        printf '%s\n' "$pid"
        continue
        ;;
    esac
    if grep -qzE '^(XRDP_SESSION|LXQT_SESSION_CONFIG)=' "/proc/$pid/environ" 2>/dev/null; then
      printf '%s\n' "$pid"
    fi
  done < <(pgrep -u "$target_uid" 2>/dev/null || true)
}

terminate_user_xrdp_session() {
  local target_user="$1"
  if [[ "${ON_CONNECT_SKIP_PROCESS_CHECK:-0}" == "1" ]]; then
    return 0
  fi

  local target_uid
  target_uid="$(id -u -- "$target_user" 2>/dev/null || true)"
  if [[ -z "$target_uid" || "$target_uid" -lt 1000 ]]; then
    return 0
  fi
  if [[ "$(id -u)" -ne 0 && "$(id -un)" != "$target_user" ]]; then
    return 0
  fi

  local sids=() pids=() sid pid
  while read -r sid; do
    [[ -n "$sid" ]] && sids+=("$sid")
  done < <(list_user_xrdp_logind_sessions "$target_user" "$target_uid")

  while read -r pid; do
    [[ -n "$pid" ]] && pids+=("$pid")
  done < <(list_user_xrdp_pids "$target_uid")

  if [[ "${#sids[@]}" -eq 0 && "${#pids[@]}" -eq 0 ]]; then
    return 0
  fi

  echo "[status] Signing out previous desktop session..."
  echo "[on-connect] Signing out xrdp desktop session for '$target_user' (uid=$target_uid, logind_sessions=${sids[*]:-none}, pids=${#pids[@]})"

  # 1. Signal lxqt-session first so xrdp-sesexec tears down the session cleanly
  if command -v pkill >/dev/null 2>&1; then
    pkill -TERM -u "$target_uid" -x lxqt-session 2>/dev/null || true
  fi

  # 2. Terminate any xrdp-sesman / X11 systemd-logind session scopes (leaves sshd untouched)
  for sid in "${sids[@]}"; do
    loginctl terminate-session "$sid" 2>/dev/null || true
  done

  # 3. Send SIGTERM to all xrdp/LXQt/Xorg processes for this user
  if [[ "${#pids[@]}" -gt 0 ]]; then
    kill -TERM "${pids[@]}" 2>/dev/null || true
  fi

  # 4. Wait up to ~2.5s for all graphical processes and logind xrdp scopes to exit
  local attempt remaining_pids remaining_sids
  for ((attempt = 1; attempt <= 25; attempt++)); do
    remaining_pids="$(list_user_xrdp_pids "$target_uid")"
    remaining_sids="$(list_user_xrdp_logind_sessions "$target_user" "$target_uid")"
    if [[ -z "$remaining_pids" && -z "$remaining_sids" ]]; then
      break
    fi
    sleep 0.1
  done

  # 5. Force-kill any stubborn X11/xrdp stragglers and free any orphaned X11 display lock
  pids=()
  while read -r pid; do
    [[ -n "$pid" ]] && pids+=("$pid")
  done < <(list_user_xrdp_pids "$target_uid")

  if [[ "${#pids[@]}" -gt 0 ]]; then
    kill -KILL "${pids[@]}" 2>/dev/null || true
    for ((attempt = 1; attempt <= 10; attempt++)); do
      [[ -z "$(list_user_xrdp_pids "$target_uid")" ]] && break
      sleep 0.05
    done

    local lockfile disp_num
    for lockfile in /tmp/.X*-lock; do
      [[ -f "$lockfile" ]] || continue
      if [[ "$(stat -c '%u' "$lockfile" 2>/dev/null || echo -1)" == "$target_uid" ]]; then
        disp_num="${lockfile#/tmp/.X}"
        disp_num="${disp_num%-lock}"
        rm -f -- "$lockfile" "/tmp/.X11-unix/X${disp_num}" 2>/dev/null || true
      fi
    done
  fi

  # Brief settle so xrdp-sesman finishes reaping xrdp-sesexec before a new login starts
  sleep 0.15
  echo "[on-connect] Signed out xrdp desktop session for '$target_user'"
}

reposition_user_plank() {
  # Legacy hook retained as a no-op: the bottom dock is now managed by lxqt-panel (panel2),
  # which automatically re-centers on X11 RandR display resize without restarting.
  return 0
}

if [[ "${1:-}" == "--system-only" ]]; then
  ON_CONNECT_SYSTEM_BOOTSTRAP=1 run_serialized_system_install
  echo "[on-connect] System-wide tool bootstrap complete"
  exit 0
fi

if [[ "${1:-}" == "--install-claude-code-only" ]]; then
  TEST_ARCH="x64"
  case "$(uname -m)" in
    aarch64|arm64) TEST_ARCH="arm64" ;;
  esac
  install_or_update_claude_code "${2:-$TEST_ARCH}"
  exit 0
fi

if [[ "${1:-}" == "--signout" ]]; then
  SIGNOUT_USER="${2:?Usage: on-connect.sh --signout <username>}"
  terminate_user_xrdp_session "$SIGNOUT_USER"
  exit 0
fi

if [[ "${1:-}" == "--reposition-plank" ]]; then
  REPOS_USER="${2:?Usage: on-connect.sh --reposition-plank <username>}"
  reposition_user_plank "$REPOS_USER"
  exit 0
fi

# ---------------------------------------------------------------------------
# Per-User Session Enforcement (<username> [homedir])
# ---------------------------------------------------------------------------
USERNAME="${1:?Usage: on-connect.sh <username> [homedir] | --signout <username> | --system-only}"
HOMEDIR="${2:-$(getent passwd -- "$USERNAME" | cut -d: -f6 || true)}"
HOMEDIR="${HOMEDIR:-/home/$USERNAME}"

USER_UID="$(id -u -- "$USERNAME" 2>/dev/null || id -u)"
USER_GID="$(id -g -- "$USERNAME" 2>/dev/null || id -g)"

fix_owner() {
  if [[ "$(id -u)" -eq 0 ]]; then
    chown "$USER_UID:$USER_GID" -- "$@"
  fi
}

ensure_user_dir() {
  local dir="$1"
  mkdir -p -- "$dir"
  chmod 0755 -- "$dir"
  fix_owner "$dir"
}

write_user_file() {
  local dest="$1"
  local mode="${2:-0644}"
  local dir
  dir="$(dirname -- "$dest")"
  ensure_user_dir "$HOMEDIR"
  ensure_user_dir "$HOMEDIR/.config"
  ensure_user_dir "$dir"

  local tmp
  tmp="$(mktemp "$dir/.tmp.XXXXXX")"
  cat >"$tmp"

  if [[ -f "$dest" ]] && cmp -s "$tmp" "$dest"; then
    rm -f -- "$tmp"
    chmod "$mode" -- "$dest"
    fix_owner "$dest"
    return 1
  fi

  chmod "$mode" -- "$tmp"
  mv -f -- "$tmp" "$dest"
  fix_owner "$dest"
  return 0
}

run_serialized_system_install

# Ensure user belongs to 'kvm' group before xrdp login so Claude Cowork's QEMU/KVM sandbox works
ensure_user_in_kvm_group "$USERNAME"

# Always sign out any previous/disconnected xrdp desktop session BEFORE writing configs
# so xrdp-sesman starts a fresh desktop sign-in and dying panel/desktop processes cannot
# overwrite newly written configuration files.
terminate_user_xrdp_session "$USERNAME"

echo "[status] Configuring LXQt desktop, wallpaper & dock launchers..."

# 2. Enforce LXQt top bar (panel1) & bottom centered dock (panel2) in ~/.config/lxqt/panel.conf
rm -f -- "$HOMEDIR/.config/autostart/lxqt-panel.desktop" "$HOMEDIR/.config/autostart/plank.desktop"
ensure_user_dir "$HOMEDIR/.local"
ensure_user_dir "$HOMEDIR/.local/share"
USER_APPS_DIR="$HOMEDIR/.local/share/applications"
ensure_user_dir "$USER_APPS_DIR"

SIGNOUT_LAUNCHER_PATH="$APPS_DIR/apigee-signout.desktop"
if [[ ! -f "$SIGNOUT_LAUNCHER_PATH" ]]; then
  SIGNOUT_LAUNCHER_PATH="$USER_APPS_DIR/apigee-signout.desktop"
  write_user_file "$SIGNOUT_LAUNCHER_PATH" 0644 <<'EOF' || true
[Desktop Entry]
Version=1.0
Type=Application
Name=Sign Out
Comment=Sign out of desktop session
Exec=lxqt-leave --logout
Icon=system-log-out
Terminal=false
NoDisplay=true
Categories=System;
EOF
fi

HOME_LAUNCHER_PATH="$APPS_DIR/apigee-user-home.desktop"
if [[ ! -f "$HOME_LAUNCHER_PATH" ]]; then
  HOME_LAUNCHER_PATH="$USER_APPS_DIR/apigee-user-home.desktop"
  write_user_file "$HOME_LAUNCHER_PATH" 0644 <<'EOF' || true
[Desktop Entry]
Version=1.0
Type=Application
Name=Home
Comment=Open Home Folder
Exec=sh -c 'exec pcmanfm-qt "$HOME"'
Icon=user-home
Terminal=false
NoDisplay=true
Categories=System;FileManager;
EOF
fi

TERM_DESKTOP_PATH="$(resolve_or_create_desktop "terminal" "QTerminal" "qterminal" "utilities-terminal" \
  qterminal.desktop org.lxqt.QTerminal.desktop org.lxqt.qterminal.desktop lxterminal.desktop xfce4-terminal.desktop xterm.desktop)"
EDITOR_DESKTOP_PATH="$(resolve_or_create_desktop "text-editor" "FeatherPad" "featherpad %F" "featherpad" \
  featherpad.desktop org.featherpad.FeatherPad.desktop mousepad.desktop org.gnome.TextEditor.desktop)"
CHROME_DESKTOP_PATH="$(resolve_or_create_desktop "chrome" "Google Chrome" "google-chrome-stable %U" "google-chrome" \
  google-chrome.desktop google-chrome-stable.desktop chromium.desktop)"
CODIUM_DESKTOP_PATH="$(resolve_or_create_desktop "codium" "VSCodium" "codium %F" "vscodium" \
  codium.desktop vscodium.desktop com.vscodium.codium.desktop)"
ANTIGRAVITY_DESKTOP_PATH="$(resolve_or_create_desktop "antigravity" "Antigravity" "/opt/antigravity/antigravity %U" "antigravity" \
  antigravity.desktop)"
CLAUDE_DESKTOP_PATH="$(resolve_or_create_desktop "claude" "Claude" "claude-desktop %U" "claude-desktop" \
  com.anthropic.Claude.desktop claude-desktop.desktop)"

LXQT_MENU_FILE="/etc/xdg/menus/lxqt-applications.menu"
if [[ ! -f "$LXQT_MENU_FILE" && -f /etc/xdg/menus/lxqt-panel-applications.menu ]]; then
  LXQT_MENU_FILE="/etc/xdg/menus/lxqt-panel-applications.menu"
fi

PANEL_CONF="$HOMEDIR/.config/lxqt/panel.conf"
write_panel_conf() {
  write_user_file "$PANEL_CONF" 0644 <<EOF
[General]
__userfile__=true
panels=panel1, panel2

[panel1]
alignment=center
position=Top
height=32
iconSize=22
width=100
width-percent=true
reserve-space=true
plugins=mainmenu, taskbar, spacer, kbindicator, signout

[mainmenu]
type=mainmenu
menu_file=$LXQT_MENU_FILE

[taskbar]
type=taskbar
buttonStyle=IconText
closeOnMiddleClick=true
showOnlyCurrentDesktop=false

[spacer]
type=spacer
size=0
expandable=true
spaceType=invisible

[kbindicator]
alignment=Right
type=kbindicator
showLayout=true
showCapslock=true
showNumlock=false
showScrolllock=false

[signout]
alignment=Right
type=quicklaunch
apps\\1\\desktop=$SIGNOUT_LAUNCHER_PATH
apps\\size=1

[panel2]
alignment=center
position=Bottom
height=96
iconSize=80
width=100
width-percent=true
reserve-space=true
hidable=false
opacity=0
plugins=dock_spacer_left, dock_launchers, dock_spacer_right

[dock_spacer_left]
type=spacer
size=0
expandable=true
spaceType=invisible

[dock_launchers]
type=quicklaunch
apps\\1\\desktop=$CHROME_DESKTOP_PATH
apps\\2\\desktop=$HOME_LAUNCHER_PATH
apps\\3\\desktop=$EDITOR_DESKTOP_PATH
apps\\4\\desktop=$ANTIGRAVITY_DESKTOP_PATH
apps\\5\\desktop=$CLAUDE_DESKTOP_PATH
apps\\size=5

[dock_spacer_right]
type=spacer
size=0
expandable=true
spaceType=invisible
EOF
}

PANEL_NEEDS_RELOAD=0
if write_panel_conf; then
  PANEL_NEEDS_RELOAD=1
  echo "[on-connect] Applied LXQt panel.conf for '$USERNAME'"
fi

# 3. Copy wallpaper.jpg into user's home directory & configure PCManFM-Qt (both lxqt and default profiles!)
USER_WALLPAPER_DIR="$HOMEDIR/.local/share/backgrounds"
USER_WALLPAPER="$USER_WALLPAPER_DIR/wallpaper.jpg"
ensure_user_dir "$USER_WALLPAPER_DIR"
rm -f -- "$USER_WALLPAPER_DIR/wallpaper.png"

PCMANFM_NEEDS_RELOAD=0
if [[ -f "$WALLPAPER_SRC" ]]; then
  if write_user_file "$USER_WALLPAPER" 0644 <"$WALLPAPER_SRC"; then
    PCMANFM_NEEDS_RELOAD=1
  fi
elif [[ -f /usr/share/backgrounds/apigee-wallpaper.jpg ]]; then
  if write_user_file "$USER_WALLPAPER" 0644 </usr/share/backgrounds/apigee-wallpaper.jpg; then
    PCMANFM_NEEDS_RELOAD=1
  fi
fi

update_pcmanfm_profile() {
  local profile_name="$1"
  local conf_dir="$HOMEDIR/.config/pcmanfm-qt/$profile_name"
  local conf_file="$conf_dir/settings.conf"
  ensure_user_dir "$HOMEDIR/.config/pcmanfm-qt"
  ensure_user_dir "$conf_dir"

  local seed="$conf_file"
  local tmp_seed=""
  if [[ ! -f "$conf_file" && -f "/etc/xdg/pcmanfm-qt/$profile_name/settings.conf" ]]; then
    tmp_seed="$(mktemp "${TMPDIR:-/tmp}/pcmanfm-seed.XXXXXX")"
    cp -- "/etc/xdg/pcmanfm-qt/$profile_name/settings.conf" "$tmp_seed"
    seed="$tmp_seed"
  fi

  local tmp_out
  tmp_out="$(mktemp "${TMPDIR:-/tmp}/pcmanfm-out.XXXXXX")"
  if [[ -f "$seed" ]]; then
    TARGET_WALLPAPER="$USER_WALLPAPER" awk '
      BEGIN {
        sec = ""
        saw_behavior = 0; set_quickexec = 0
        saw_desktop = 0; set_wp = 0; set_wpmode = 0; set_comp = 0; set_net = 0
      }
      function flush_sec() {
        if (sec == "Behavior" && !set_quickexec) {
          print "QuickExec=true"
          set_quickexec = 1
        } else if (sec == "Desktop") {
          if (!set_wp) { print "Wallpaper=" ENVIRON["TARGET_WALLPAPER"]; set_wp = 1 }
          if (!set_wpmode) { print "WallpaperMode=zoom"; set_wpmode = 1 }
          if (!set_comp) { print "ShowComputer=false"; set_comp = 1 }
          if (!set_net) { print "ShowNetwork=false"; set_net = 1 }
        }
      }
      /^\[[^]]+\][ \t]*$/ {
        flush_sec()
        sec = $0
        sub(/^\[/, "", sec)
        sub(/\][ \t]*$/, "", sec)
        if (sec == "Behavior") saw_behavior = 1
        if (sec == "Desktop") saw_desktop = 1
        print $0
        next
      }
      {
        if (sec == "Behavior" && $0 ~ /^QuickExec=/) {
          print "QuickExec=true"
          set_quickexec = 1
          next
        }
        if (sec == "Desktop") {
          if ($0 ~ /^Wallpaper=/) {
            print "Wallpaper=" ENVIRON["TARGET_WALLPAPER"]
            set_wp = 1
            next
          }
          if ($0 ~ /^WallpaperMode=/) {
            print "WallpaperMode=zoom"
            set_wpmode = 1
            next
          }
          if ($0 ~ /^ShowComputer=/) {
            print "ShowComputer=false"
            set_comp = 1
            next
          }
          if ($0 ~ /^ShowNetwork=/) {
            print "ShowNetwork=false"
            set_net = 1
            next
          }
        }
        print $0
      }
      END {
        flush_sec()
        if (!saw_behavior) {
          print ""
          print "[Behavior]"
          print "QuickExec=true"
        }
        if (!saw_desktop) {
          print ""
          print "[Desktop]"
          print "Wallpaper=" ENVIRON["TARGET_WALLPAPER"]
          print "WallpaperMode=zoom"
          print "ShowComputer=false"
          print "ShowNetwork=false"
        }
      }
    ' "$seed" >"$tmp_out"
  else
    cat >"$tmp_out" <<EOF
[Behavior]
QuickExec=true

[Desktop]
Wallpaper=$USER_WALLPAPER
WallpaperMode=zoom
ShowComputer=false
ShowNetwork=false
EOF
  fi
  [[ -n "$tmp_seed" ]] && rm -f -- "$tmp_seed"

  if write_user_file "$conf_file" 0644 <"$tmp_out"; then
    PCMANFM_NEEDS_RELOAD=1
  fi
  rm -f -- "$tmp_out"
}

update_pcmanfm_profile "lxqt"
update_pcmanfm_profile "default"

# 4. Configure XDG portal backend, GTK3 icon theme fallback & Plank/Session-Init XDG autostart (~/.config/autostart/)
if [[ -f /usr/share/icons/Adwaita/index.theme && ! -f "$HOMEDIR/.config/gtk-3.0/settings.ini" ]]; then
  write_user_file "$HOMEDIR/.config/gtk-3.0/settings.ini" 0644 <<'EOF' || true
[Settings]
gtk-icon-theme-name=Adwaita
EOF
fi

PORTALS_CONF="$HOMEDIR/.config/xdg-desktop-portal/portals.conf"
write_user_file "$PORTALS_CONF" 0644 <<'EOF' || true
[preferred]
default=gtk
EOF

rm -f -- "$HOMEDIR/.config/autostart/plank.desktop"

PICOM_AUTOSTART="$HOMEDIR/.config/autostart/picom.desktop"
write_user_file "$PICOM_AUTOSTART" 0644 <<'EOF' || true
[Desktop Entry]
Type=Application
Name=Picom Compositor
Comment=Lightweight X11 compositor for panel transparency
Exec=picom --backend xrender --no-fading-openclose
Terminal=false
Hidden=false
NoDisplay=true
EOF

SESSION_INIT_AUTOSTART="$HOMEDIR/.config/autostart/apigee-session-init.desktop"
write_user_file "$SESSION_INIT_AUTOSTART" 0644 <<'EOF' || true
[Desktop Entry]
Type=Application
Name=Apigee Session Setup
Comment=Marks desktop shortcuts trusted and verifies LXQt panel
Exec=/usr/local/bin/apigee-session-init
Terminal=false
Hidden=false
NoDisplay=true
EOF

# 5. Populate Desktop shortcuts (~/Desktop)
DESKTOP_DIR="$HOMEDIR/Desktop"
ensure_user_dir "$DESKTOP_DIR"

# Shortcuts placed on ~/Desktop: Terminal, Chrome, VSCodium, Antigravity, Claude (remove old/url-handler shortcuts).
# Written as Type=Link shortcuts targeting /usr/share/applications/*.desktop: in LXQt libfm-qt
# (FileInfo::isExecutableType), Type=Link entries targeting /usr/share/* are inherently trusted on disk
# without needing GVFS metadata, avoiding both the '!' untrusted emblem and symlink arrow emblem.
rm -f -- \
  "$DESKTOP_DIR/antigravity-ide.desktop" \
  "$DESKTOP_DIR/antigravity-cli.desktop" \
  "$DESKTOP_DIR"/*url-handler*.desktop

write_desktop_shortcut() {
  local src_desktop="$1"
  local dest_desktop="$2"
  local override_name="${3:-}"
  [[ ! -f "$src_desktop" ]] && return 0

  local entry_name entry_icon entry_comment
  entry_name="$override_name"
  if [[ -z "$entry_name" ]]; then
    entry_name="$(awk '
      /^\[Desktop Entry\][ \t]*$/ { in_de=1; next }
      /^\[[^]]+\][ \t]*$/ { in_de=0 }
      in_de && /^Name=/ { sub(/^Name=/, ""); print; exit }
    ' "$src_desktop")"
  fi
  entry_icon="$(awk '
    /^\[Desktop Entry\][ \t]*$/ { in_de=1; next }
    /^\[[^]]+\][ \t]*$/ { in_de=0 }
    in_de && /^Icon=/ { sub(/^Icon=/, ""); print; exit }
  ' "$src_desktop")"
  entry_comment="$(awk '
    /^\[Desktop Entry\][ \t]*$/ { in_de=1; next }
    /^\[[^]]+\][ \t]*$/ { in_de=0 }
    in_de && /^Comment=/ { sub(/^Comment=/, ""); print; exit }
  ' "$src_desktop")"

  entry_name="${entry_name:-$(basename -- "$src_desktop" .desktop)}"
  entry_icon="${entry_icon:-application-x-executable}"

  {
    printf '[Desktop Entry]\n'
    printf 'Version=1.0\n'
    printf 'Type=Link\n'
    printf 'Name=%s\n' "$entry_name"
    [[ -n "$entry_comment" ]] && printf 'Comment=%s\n' "$entry_comment"
    printf 'Icon=%s\n' "$entry_icon"
    printf 'URL=%s\n' "$src_desktop"
  } | write_user_file "$dest_desktop" 0644 || true
}

write_desktop_shortcut "$TERM_DESKTOP_PATH" "$DESKTOP_DIR/qterminal.desktop" "Terminal"
write_desktop_shortcut "$CHROME_DESKTOP_PATH" "$DESKTOP_DIR/google-chrome.desktop"
write_desktop_shortcut "$CODIUM_DESKTOP_PATH" "$DESKTOP_DIR/codium.desktop" "VSCodium"
write_desktop_shortcut "$ANTIGRAVITY_DESKTOP_PATH" "$DESKTOP_DIR/antigravity.desktop" "Antigravity"
write_desktop_shortcut "$CLAUDE_DESKTOP_PATH" "$DESKTOP_DIR/claude.desktop" "Claude"

# Remove any other stale .desktop shortcut names left in ~/Desktop from previous runs
for existing_desk in "$DESKTOP_DIR"/*.desktop; do
  [[ ! -e "$existing_desk" ]] && continue
  case "$(basename -- "$existing_desk")" in
    qterminal.desktop|google-chrome.desktop|codium.desktop|antigravity.desktop|claude.desktop) ;;
    *) rm -f -- "$existing_desk" ;;
  esac
done

# Keep ~/.local/bin/agy and ~/.local/bin/claude aligned with system binaries if user had older local copies
if [[ -x /usr/local/bin/agy && -e "$HOMEDIR/.local/bin/agy" && ! -L "$HOMEDIR/.local/bin/agy" ]]; then
  ln -sf /usr/local/bin/agy "$HOMEDIR/.local/bin/agy"
  if [[ "$(id -u)" -eq 0 ]]; then
    chown -h "$USER_UID:$USER_GID" -- "$HOMEDIR/.local/bin/agy"
  fi
fi
SYS_CLAUDE_BIN="${ON_CONNECT_CLAUDE_BIN:-/usr/local/bin/claude}"
if [[ -x "$SYS_CLAUDE_BIN" && -e "$HOMEDIR/.local/bin/claude" && ! -L "$HOMEDIR/.local/bin/claude" ]]; then
  ln -sf "$SYS_CLAUDE_BIN" "$HOMEDIR/.local/bin/claude"
  if [[ "$(id -u)" -eq 0 ]]; then
    chown -h "$USER_UID:$USER_GID" -- "$HOMEDIR/.local/bin/claude"
  fi
fi
