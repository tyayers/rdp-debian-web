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

# ---------------------------------------------------------------------------
# 1. System-wide tool installation (installed ONCE on the VM for all users)
# ---------------------------------------------------------------------------
install_or_update_system_tools() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "[on-connect] Warning: not running as root; skipping system package checks" >&2
    return 0
  fi

  export DEBIAN_FRONTEND=noninteractive

  local uname_m deb_arch cli_arch app_platform
  uname_m="$(uname -m)"
  deb_arch="$(dpkg --print-architecture 2>/dev/null || echo amd64)"
  case "$uname_m" in
    x86_64|amd64)
      cli_arch="amd64"
      app_platform="linux-x64"
      ;;
    aarch64|arm64)
      cli_arch="arm64"
      app_platform="linux-arm"
      ;;
    *)
      cli_arch="amd64"
      app_platform="linux-x64"
      ;;
  esac

  # 1a. Base desktop packages: Plank, QTerminal, PCManFM-Qt, FeatherPad, LXQt menu data, GIO/GVFS & dconf
  local missing_base=0
  local cmd
  for cmd in curl gpg plank qterminal pcmanfm-qt featherpad lxqt-leave gio dconf; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing_base=1
      break
    fi
  done
  if [[ ! -f /etc/xdg/menus/lxqt-applications.menu ]]; then
    missing_base=1
  fi
  if [[ "$missing_base" -eq 1 ]]; then
    echo "[status] Installing Plank, LXQt menu data, Terminal, Text Editor & desktop utilities..."
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends \
      ca-certificates curl gpg plank qterminal pcmanfm-qt featherpad \
      lxqt-menu-data lxqt-session libglib2.0-bin gvfs dconf-cli
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
    apt-get update -qq
    apt-get install -y -qq codium
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
      apt-get update -qq
      apt-get install -y -qq google-chrome-stable
    else
      apt-get update -qq
      apt-get install -y -qq chromium
    fi
  fi

  install -d -m 0755 \
    /usr/local/bin \
    /usr/local/share/antigravity \
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

  # 1g. Shared "Home" launcher (Plank dock) & "Sign Out" launcher (LXQt top panel right side)
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

  # 1h. Session startup helper ensuring GVFS desktop shortcut trust, Plank dock order, and lxqt-panel
  cat >/usr/local/bin/apigee-session-init <<'EOF'
#!/usr/bin/env bash
# Runs inside the user's active LXQt D-Bus/X11 session on login (and on reconnect)
export XDG_CURRENT_DESKTOP="${XDG_CURRENT_DESKTOP:-LXQt}"
export XDG_MENU_PREFIX="${XDG_MENU_PREFIX:-lxqt-}"

apply_trust_and_dock() {
  # 1. Mark any ~/Desktop/*.desktop files trusted in GVFS (LXQt libfm-qt uses 'metadata::trust')
  if command -v gio >/dev/null 2>&1 && [[ -d "$HOME/Desktop" ]]; then
    for f in "$HOME/Desktop"/*.desktop; do
      [[ -f "$f" ]] || continue
      gio set -t string "$f" metadata::trust true 2>/dev/null || true
      gio set -t string "$f" metadata::trusted true 2>/dev/null || true
    done
  fi

  # 2. Sync Plank dock-items ordering via dconf if available
  if command -v dconf >/dev/null 2>&1 && [[ -d "$HOME/.config/plank/dock1/launchers" ]]; then
    local items=() item joined
    for item in "$HOME/.config/plank/dock1/launchers"/*.dockitem; do
      [[ -f "$item" ]] || continue
      items+=("'$(basename -- "$item")'")
    done
    if [[ "${#items[@]}" -gt 0 ]]; then
      joined="$(IFS=,; printf '%s' "${items[*]}")"
      dconf write /net/launchpad/plank/docks/dock1/dock-items "[${joined}]" 2>/dev/null || true
      dconf write /net/launchpad/plank/docks/dock1/show-dock-item "false" 2>/dev/null || true
    fi
  fi
}

ensure_panel_and_dock_running() {
  if command -v lxqt-panel >/dev/null 2>&1 && ! pgrep -u "$(id -u)" -x lxqt-panel >/dev/null 2>&1; then
    nohup lxqt-panel </dev/null >/dev/null 2>&1 &
  fi
  if command -v plank >/dev/null 2>&1 && ! pgrep -u "$(id -u)" -x plank >/dev/null 2>&1; then
    nohup plank </dev/null >/dev/null 2>&1 &
  fi
}

apply_trust_and_dock
if [[ "${1:-}" == "--Immediate" ]]; then
  ensure_panel_and_dock_running
else
  (
    sleep 2
    apply_trust_and_dock
    ensure_panel_and_dock_running
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
      lxqt-session|lxqt-panel|pcmanfm-qt|plank|openbox|xfwm4|xrdp-chansrv|Xorg|Xvnc)
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

if [[ "${1:-}" == "--system-only" ]]; then
  run_serialized_system_install
  echo "[on-connect] System-wide tool bootstrap complete"
  exit 0
fi

if [[ "${1:-}" == "--signout" ]]; then
  SIGNOUT_USER="${2:?Usage: on-connect.sh --signout <username>}"
  terminate_user_xrdp_session "$SIGNOUT_USER"
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

# Always sign out any previous/disconnected xrdp desktop session BEFORE writing configs
# so xrdp-sesman starts a fresh desktop sign-in and dying panel/desktop processes cannot
# overwrite newly written configuration files.
terminate_user_xrdp_session "$USERNAME"

echo "[status] Configuring LXQt desktop, wallpaper & Plank launchers..."

# 2. Enforce LXQt top panel configuration (~/.config/lxqt/panel.conf) & ensure panel is never disabled
rm -f -- "$HOMEDIR/.config/autostart/lxqt-panel.desktop"
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

LXQT_MENU_FILE="/etc/xdg/menus/lxqt-applications.menu"
if [[ ! -f "$LXQT_MENU_FILE" && -f /etc/xdg/menus/lxqt-panel-applications.menu ]]; then
  LXQT_MENU_FILE="/etc/xdg/menus/lxqt-panel-applications.menu"
fi

PANEL_CONF="$HOMEDIR/.config/lxqt/panel.conf"
write_panel_conf() {
  write_user_file "$PANEL_CONF" 0644 <<EOF
[General]
__userfile__=true
panels=panel1

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
        saw_desktop = 0; set_wp = 0; set_wpmode = 0
      }
      function flush_sec() {
        if (sec == "Behavior" && !set_quickexec) {
          print "QuickExec=true"
          set_quickexec = 1
        } else if (sec == "Desktop") {
          if (!set_wp) { print "Wallpaper=" ENVIRON["TARGET_WALLPAPER"]; set_wp = 1 }
          if (!set_wpmode) { print "WallpaperMode=zoom"; set_wpmode = 1 }
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

# 4. Ensure Plank & Session Init helper are configured in XDG autostart (~/.config/autostart/)
PLANK_AUTOSTART="$HOMEDIR/.config/autostart/plank.desktop"
write_user_file "$PLANK_AUTOSTART" 0644 <<'EOF' || true
[Desktop Entry]
Type=Application
Name=Plank
Comment=Dock
Exec=plank
Icon=plank
Terminal=false
Hidden=false
NoDisplay=false
EOF

SESSION_INIT_AUTOSTART="$HOMEDIR/.config/autostart/apigee-session-init.desktop"
write_user_file "$SESSION_INIT_AUTOSTART" 0644 <<'EOF' || true
[Desktop Entry]
Type=Application
Name=Apigee Session Setup
Comment=Marks desktop shortcuts trusted and verifies panel & dock
Exec=/usr/local/bin/apigee-session-init
Terminal=false
Hidden=false
NoDisplay=true
EOF

# 5. Populate Desktop shortcuts (~/Desktop) & Plank launchers (dock1/launchers)
DESKTOP_DIR="$HOMEDIR/Desktop"
PLANK_LAUNCHERS_DIR="$HOMEDIR/.config/plank/dock1/launchers"
ensure_user_dir "$DESKTOP_DIR"
ensure_user_dir "$HOMEDIR/.config/plank"
ensure_user_dir "$HOMEDIR/.config/plank/dock1"
ensure_user_dir "$PLANK_LAUNCHERS_DIR"

# Ensure per-user Home folder launcher exists (used by Plank's Home dock icon)
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

TERM_DESKTOP="$(find_existing_desktop qterminal.desktop lxterminal.desktop xfce4-terminal.desktop xterm.desktop)"
EDITOR_DESKTOP="$(find_existing_desktop featherpad.desktop org.featherpad.FeatherPad.desktop mousepad.desktop org.gnome.TextEditor.desktop)"
CHROME_DESKTOP="$(find_existing_desktop google-chrome.desktop chromium.desktop)"
CODIUM_DESKTOP="codium.desktop"
ANTIGRAVITY_APP_DESKTOP="antigravity.desktop"

# Shortcuts placed on ~/Desktop: Terminal, Chrome, VSCodium, Antigravity (remove old IDE/CLI shortcuts).
# Written as Type=Link shortcuts targeting /usr/share/applications/*.desktop: in LXQt libfm-qt
# (FileInfo::isExecutableType), Type=Link entries targeting /usr/share/* are inherently trusted on disk
# without needing GVFS metadata, avoiding both the '!' untrusted emblem and symlink arrow emblem.
rm -f -- "$DESKTOP_DIR/antigravity-ide.desktop" "$DESKTOP_DIR/antigravity-cli.desktop"
DESKTOP_SHORTCUTS=(
  "$TERM_DESKTOP"
  "$CHROME_DESKTOP"
  "$CODIUM_DESKTOP"
  "$ANTIGRAVITY_APP_DESKTOP"
)

write_desktop_shortcut() {
  local src_desktop="$1"
  local dest_desktop="$2"
  [[ ! -f "$src_desktop" ]] && return 0

  local entry_name entry_icon entry_comment
  entry_name="$(awk '
    /^\[Desktop Entry\][ \t]*$/ { in_de=1; next }
    /^\[[^]]+\][ \t]*$/ { in_de=0 }
    in_de && /^Name=/ { sub(/^Name=/, ""); print; exit }
  ' "$src_desktop")"
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

for desktop_file in "${DESKTOP_SHORTCUTS[@]}"; do
  [[ -z "$desktop_file" ]] && continue
  write_desktop_shortcut "$APPS_DIR/$desktop_file" "$DESKTOP_DIR/$desktop_file"
done

# Exact Plank dock items: Home, Chrome, VSCodium, Terminal, Text Editor, Antigravity
declare -A EXPECTED_DOCKITEMS=()
PLANK_CHANGED=0

add_plank_item() {
  local idx="$1"
  local slug="$2"
  local launcher_path="$3"
  [[ ! -f "$launcher_path" ]] && return 0

  local dockitem_name
  dockitem_name="$(printf '%02d-%s.dockitem' "$idx" "$slug")"
  EXPECTED_DOCKITEMS["$dockitem_name"]=1

  if write_user_file "$PLANK_LAUNCHERS_DIR/$dockitem_name" 0644 <<EOF
[PlankItemsDockItemPreferences]
Launcher=file://$launcher_path
EOF
  then
    PLANK_CHANGED=1
  fi
}

add_plank_item 1 "home" "$HOME_LAUNCHER_PATH"
add_plank_item 2 "chrome" "$APPS_DIR/$CHROME_DESKTOP"
add_plank_item 3 "codium" "$APPS_DIR/$CODIUM_DESKTOP"
add_plank_item 4 "terminal" "$APPS_DIR/$TERM_DESKTOP"
add_plank_item 5 "text-editor" "$APPS_DIR/$EDITOR_DESKTOP"
add_plank_item 6 "antigravity" "$APPS_DIR/$ANTIGRAVITY_APP_DESKTOP"

# Remove ALL other .dockitem files (including Plank's unnumbered first-run defaults like pcmanfm-qt/clock)
for existing_item in "$PLANK_LAUNCHERS_DIR"/*.dockitem; do
  [[ ! -e "$existing_item" ]] && continue
  item_base="$(basename -- "$existing_item")"
  if [[ -z "${EXPECTED_DOCKITEMS[$item_base]:-}" ]]; then
    rm -f -- "$existing_item"
    PLANK_CHANGED=1
  fi
done

# Keep ~/.local/bin/agy aligned with system /usr/local/bin/agy if user had an older local copy
if [[ -x /usr/local/bin/agy && -e "$HOMEDIR/.local/bin/agy" && ! -L "$HOMEDIR/.local/bin/agy" ]]; then
  ln -sf /usr/local/bin/agy "$HOMEDIR/.local/bin/agy"
  [[ "$(id -u)" -eq 0 ]] && chown -h "$USER_UID:$USER_GID" -- "$HOMEDIR/.local/bin/agy"
fi
