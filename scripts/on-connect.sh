#!/usr/bin/env bash
# Apigee AI Demos — VM Bootstrap & Per-Connect User Desktop Enforcement Script
#
# Modes:
#   1) System-wide bootstrap (run once at server startup as root for all users):
#        ./scripts/on-connect.sh --system-only
#   2) Per-user session setup (run before opening xrdp for <username>):
#        ./scripts/on-connect.sh <username> [homedir]

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_WALLPAPER_SRC="$SCRIPT_DIR/../public/wallpaper.png"
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

  local uname_m deb_arch cli_arch ide_platform
  uname_m="$(uname -m)"
  deb_arch="$(dpkg --print-architecture 2>/dev/null || echo amd64)"
  case "$uname_m" in
    x86_64|amd64)
      cli_arch="amd64"
      ide_platform="linux-x64"
      ;;
    aarch64|arm64)
      cli_arch="arm64"
      ide_platform="linux-arm"
      ;;
    *)
      cli_arch="amd64"
      ide_platform="linux-x64"
      ;;
  esac

  # 1a. Base desktop packages: Plank dock, QTerminal, PCManFM-Qt file manager, FeatherPad text editor
  local missing_base=0
  local cmd
  for cmd in curl gpg plank qterminal pcmanfm-qt featherpad; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing_base=1
      break
    fi
  done
  if [[ "$missing_base" -eq 1 ]]; then
    echo "[status] Installing Plank, Terminal, File Manager & Text Editor..."
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends \
      ca-certificates curl gpg plank qterminal pcmanfm-qt featherpad
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

  # 1d. Antigravity CLI (current latest release installed to /usr/local/bin/agy for all users)
  install -d -m 0755 /usr/local/bin /usr/local/share/antigravity /usr/share/pixmaps /usr/share/applications /usr/share/backgrounds
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

  if [[ ! -f /usr/share/pixmaps/antigravity-cli.png ]]; then
    curl -fsSL --max-time 8 -o /usr/share/pixmaps/antigravity-cli.png \
      "https://antigravity.google/assets/image/antigravity-logo.png" 2>/dev/null || true
    [[ -f /usr/share/pixmaps/antigravity-cli.png ]] && chmod 0644 /usr/share/pixmaps/antigravity-cli.png
  fi

  cat >/usr/local/bin/agy-terminal <<'EOF'
#!/usr/bin/env bash
cd "$HOME" || exit 1
if command -v qterminal >/dev/null 2>&1; then
  exec qterminal -w "$HOME" -e "/usr/local/bin/agy"
fi
for term in x-terminal-emulator lxterminal xfce4-terminal gnome-terminal xterm; do
  if command -v "$term" >/dev/null 2>&1; then
    exec "$term" -e /usr/local/bin/agy
  fi
done
exec /usr/local/bin/agy
EOF
  chmod 0755 /usr/local/bin/agy-terminal

  local cli_icon="utilities-terminal"
  if [[ -s /usr/share/pixmaps/antigravity-cli.png ]]; then
    cli_icon="/usr/share/pixmaps/antigravity-cli.png"
  fi
  cat >/usr/share/applications/antigravity-cli.desktop <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=Antigravity CLI
Comment=Google Antigravity AI Agent CLI (agy)
Exec=/usr/local/bin/agy-terminal
Icon=$cli_icon
Terminal=false
StartupNotify=false
Categories=Development;Utility;
EOF
  chmod 0644 /usr/share/applications/antigravity-cli.desktop

  # 1e. Antigravity IDE (current latest release installed to /opt/antigravity-ide for all users)
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
    ide_url="https://edgedl.me.gvt1.com/edgedl/release2/j0qc3/antigravity/stable/${ide_release_id}/${ide_platform}/Antigravity%20IDE.tar.gz"
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
    elif [[ -s /opt/antigravity-ide/resources/app/resources/linux/code.png ]]; then
      ide_icon="/opt/antigravity-ide/resources/app/resources/linux/code.png"
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

  # Stage shared copy of wallpaper in /usr/share/backgrounds as well
  if [[ -f "$WALLPAPER_SRC" ]]; then
    install -m 0644 "$WALLPAPER_SRC" /usr/share/backgrounds/apigee-wallpaper.png
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

if [[ "${1:-}" == "--system-only" ]]; then
  run_serialized_system_install
  echo "[on-connect] System-wide tool bootstrap complete"
  exit 0
fi

# ---------------------------------------------------------------------------
# Per-User Session Enforcement (<username> [homedir])
# ---------------------------------------------------------------------------
USERNAME="${1:?Usage: on-connect.sh <username> [homedir] | --system-only}"
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

echo "[status] Configuring LXQt desktop, wallpaper & Plank launchers..."

# 2. Enforce LXQt top panel configuration (~/.config/lxqt/panel.conf)
PANEL_CONF="$HOMEDIR/.config/lxqt/panel.conf"
if write_user_file "$PANEL_CONF" 0644 <<'EOF'
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
plugins=mainmenu, taskbar, spacer, kbindicator

[mainmenu]
type=mainmenu

[taskbar]
type=taskbar
buttonStyle=IconText
closeOnMiddleClick=true
showOnlyCurrentDesktop=false

[spacer]
type=spacer
size=0

[kbindicator]
type=kbindicator
showLayout=true
showCapslock=true
showNumlock=false
showScrolllock=false
EOF
then
  echo "[on-connect] Applied LXQt panel.conf for '$USERNAME'"
fi

# 3. Copy wallpaper into user's home directory & configure PCManFM-Qt Desktop
USER_WALLPAPER_DIR="$HOMEDIR/.local/share/backgrounds"
USER_WALLPAPER="$USER_WALLPAPER_DIR/wallpaper.png"
ensure_user_dir "$HOMEDIR/.local"
ensure_user_dir "$HOMEDIR/.local/share"
ensure_user_dir "$USER_WALLPAPER_DIR"

WALLPAPER_UPDATED=0
if [[ -f "$WALLPAPER_SRC" ]]; then
  if write_user_file "$USER_WALLPAPER" 0644 <"$WALLPAPER_SRC"; then
    WALLPAPER_UPDATED=1
  fi
elif [[ -f /usr/share/backgrounds/apigee-wallpaper.png ]]; then
  if write_user_file "$USER_WALLPAPER" 0644 </usr/share/backgrounds/apigee-wallpaper.png; then
    WALLPAPER_UPDATED=1
  fi
fi

PCMANFM_CONF="$HOMEDIR/.config/pcmanfm-qt/lxqt/settings.conf"
ensure_user_dir "$HOMEDIR/.config/pcmanfm-qt"
ensure_user_dir "$HOMEDIR/.config/pcmanfm-qt/lxqt"

PCMANFM_SEED="$PCMANFM_CONF"
TMP_PCMANFM_SEED=""
if [[ ! -f "$PCMANFM_CONF" && -f /etc/xdg/pcmanfm-qt/lxqt/settings.conf ]]; then
  TMP_PCMANFM_SEED="$(mktemp "${TMPDIR:-/tmp}/pcmanfm-seed.XXXXXX")"
  cp -- /etc/xdg/pcmanfm-qt/lxqt/settings.conf "$TMP_PCMANFM_SEED"
  PCMANFM_SEED="$TMP_PCMANFM_SEED"
fi

TMP_PCMANFM_OUT="$(mktemp "${TMPDIR:-/tmp}/pcmanfm-out.XXXXXX")"
if [[ -f "$PCMANFM_SEED" ]]; then
  TARGET_WALLPAPER="$USER_WALLPAPER" awk '
    BEGIN {
      sec = ""
      saw_behavior = 0; set_quickexec = 0
      saw_desktop = 0; set_wp = 0; set_wpmode = 0; set_bgcolor = 0
    }
    function flush_sec() {
      if (sec == "Behavior" && !set_quickexec) {
        print "QuickExec=true"
        set_quickexec = 1
      } else if (sec == "Desktop") {
        if (!set_wp) { print "Wallpaper=" ENVIRON["TARGET_WALLPAPER"]; set_wp = 1 }
        if (!set_wpmode) { print "WallpaperMode=fit"; set_wpmode = 1 }
        if (!set_bgcolor) { print "BgColor=#1e1e21"; set_bgcolor = 1 }
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
          print "WallpaperMode=fit"
          set_wpmode = 1
          next
        }
        if ($0 ~ /^BgColor=/) {
          print "BgColor=#1e1e21"
          set_bgcolor = 1
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
        print "WallpaperMode=fit"
        print "BgColor=#1e1e21"
      }
    }
  ' "$PCMANFM_SEED" >"$TMP_PCMANFM_OUT"
else
  cat >"$TMP_PCMANFM_OUT" <<EOF
[Behavior]
QuickExec=true

[Desktop]
Wallpaper=$USER_WALLPAPER
WallpaperMode=fit
BgColor=#1e1e21
EOF
fi
[[ -n "$TMP_PCMANFM_SEED" ]] && rm -f -- "$TMP_PCMANFM_SEED"

if write_user_file "$PCMANFM_CONF" 0644 <"$TMP_PCMANFM_OUT"; then
  WALLPAPER_UPDATED=1
fi
rm -f -- "$TMP_PCMANFM_OUT"

# 4. Ensure Plank is configured in XDG autostart (~/.config/autostart/plank.desktop)
PLANK_AUTOSTART="$HOMEDIR/.config/autostart/plank.desktop"
if write_user_file "$PLANK_AUTOSTART" 0644 <<'EOF'
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
then
  echo "[on-connect] Added Plank to autostart for '$USERNAME'"
fi

# 5. Populate Desktop shortcuts (~/Desktop) & Plank launchers (dock1/launchers)
DESKTOP_DIR="$HOMEDIR/Desktop"
PLANK_LAUNCHERS_DIR="$HOMEDIR/.config/plank/dock1/launchers"
ensure_user_dir "$DESKTOP_DIR"
ensure_user_dir "$HOMEDIR/.config/plank"
ensure_user_dir "$HOMEDIR/.config/plank/dock1"
ensure_user_dir "$PLANK_LAUNCHERS_DIR"

TERM_DESKTOP="$(find_existing_desktop qterminal.desktop lxterminal.desktop xfce4-terminal.desktop xterm.desktop)"
FILEMAN_DESKTOP="$(find_existing_desktop pcmanfm-qt.desktop thunar.desktop org.gnome.Nautilus.desktop)"
EDITOR_DESKTOP="$(find_existing_desktop featherpad.desktop org.featherpad.FeatherPad.desktop mousepad.desktop org.gnome.TextEditor.desktop)"
CHROME_DESKTOP="$(find_existing_desktop google-chrome.desktop chromium.desktop)"
CODIUM_DESKTOP="codium.desktop"
AGY_IDE_DESKTOP="antigravity-ide.desktop"
AGY_CLI_DESKTOP="antigravity-cli.desktop"

# Shortcuts placed on ~/Desktop: Terminal, Chrome, VSCodium, Antigravity IDE, Antigravity CLI
DESKTOP_SHORTCUTS=(
  "$TERM_DESKTOP"
  "$CHROME_DESKTOP"
  "$CODIUM_DESKTOP"
  "$AGY_IDE_DESKTOP"
  "$AGY_CLI_DESKTOP"
)

for desktop_file in "${DESKTOP_SHORTCUTS[@]}"; do
  [[ -z "$desktop_file" ]] && continue
  src_desktop="$APPS_DIR/$desktop_file"
  [[ ! -f "$src_desktop" ]] && continue
  write_user_file "$DESKTOP_DIR/$desktop_file" 0755 <"$src_desktop" || true
done

# Shortcuts pinned on Plank dock: File Manager, Terminal, Text Editor, Chrome, VSCodium, Antigravity IDE, Antigravity CLI
PLANK_SHORTCUTS=(
  "$FILEMAN_DESKTOP"
  "$TERM_DESKTOP"
  "$EDITOR_DESKTOP"
  "$CHROME_DESKTOP"
  "$CODIUM_DESKTOP"
  "$AGY_IDE_DESKTOP"
  "$AGY_CLI_DESKTOP"
)

declare -A EXPECTED_DOCKITEMS=()
dock_seq=0
for desktop_file in "${PLANK_SHORTCUTS[@]}"; do
  [[ -z "$desktop_file" ]] && continue
  src_desktop="$APPS_DIR/$desktop_file"
  [[ ! -f "$src_desktop" ]] && continue

  dock_seq=$((dock_seq + 1))
  base_name="${desktop_file%.desktop}"
  dockitem_name="$(printf '%02d-%s.dockitem' "$dock_seq" "$base_name")"
  EXPECTED_DOCKITEMS["$dockitem_name"]=1

  write_user_file "$PLANK_LAUNCHERS_DIR/$dockitem_name" 0644 <<EOF || true
[PlankItemsDockItemPreferences]
Launcher=file://$src_desktop
EOF
done

# Remove any outdated numbered dockitems from previous ordering so icons never duplicate
for existing_item in "$PLANK_LAUNCHERS_DIR"/[0-9][0-9]-*.dockitem; do
  [[ ! -e "$existing_item" ]] && continue
  item_base="$(basename -- "$existing_item")"
  if [[ -z "${EXPECTED_DOCKITEMS[$item_base]:-}" ]]; then
    rm -f -- "$existing_item"
  fi
done

# Keep ~/.local/bin/agy aligned with system /usr/local/bin/agy if user had an older local copy
if [[ -x /usr/local/bin/agy && -e "$HOMEDIR/.local/bin/agy" && ! -L "$HOMEDIR/.local/bin/agy" ]]; then
  ln -sf /usr/local/bin/agy "$HOMEDIR/.local/bin/agy"
  [[ "$(id -u)" -eq 0 ]] && chown -h "$USER_UID:$USER_GID" -- "$HOMEDIR/.local/bin/agy"
fi

# 6. Apply live updates (Plank + Wallpaper) if reconnecting to an already-running LXQt session
if [[ "${ON_CONNECT_SKIP_PROCESS_CHECK:-0}" != "1" ]] && command -v pgrep >/dev/null 2>&1; then
  LXQT_PID="$(pgrep -u "$USER_UID" -x lxqt-session 2>/dev/null | head -n1 || true)"
  if [[ -n "$LXQT_PID" && -r "/proc/$LXQT_PID/environ" ]]; then
    SAVED_DISPLAY=""
    SAVED_XAUTH=""
    SAVED_XDG_RUNTIME=""
    SAVED_DBUS=""
    while IFS='=' read -r -d '' k v; do
      case "$k" in
        DISPLAY) SAVED_DISPLAY="$v" ;;
        XAUTHORITY) SAVED_XAUTH="$v" ;;
        XDG_RUNTIME_DIR) SAVED_XDG_RUNTIME="$v" ;;
        DBUS_SESSION_BUS_ADDRESS) SAVED_DBUS="$v" ;;
      esac
    done <"/proc/$LXQT_PID/environ" || true

    if [[ -n "$SAVED_DISPLAY" ]]; then
      ENV_ARGS=("DISPLAY=$SAVED_DISPLAY" "HOME=$HOMEDIR" "USER=$USERNAME" "LOGNAME=$USERNAME")
      [[ -n "$SAVED_XAUTH" ]] && ENV_ARGS+=("XAUTHORITY=$SAVED_XAUTH")
      [[ -n "$SAVED_XDG_RUNTIME" ]] && ENV_ARGS+=("XDG_RUNTIME_DIR=$SAVED_XDG_RUNTIME")
      [[ -n "$SAVED_DBUS" ]] && ENV_ARGS+=("DBUS_SESSION_BUS_ADDRESS=$SAVED_DBUS")

      if command -v plank >/dev/null 2>&1 && ! pgrep -u "$USER_UID" -x plank >/dev/null 2>&1; then
        if [[ "$(id -u)" -eq 0 ]] && command -v runuser >/dev/null 2>&1; then
          runuser -u "$USERNAME" -- env "${ENV_ARGS[@]}" nohup plank </dev/null >/dev/null 2>&1 &
        elif [[ "$(id -u)" -eq "$USER_UID" ]]; then
          env "${ENV_ARGS[@]}" nohup plank </dev/null >/dev/null 2>&1 &
        fi
        echo "[on-connect] Started Plank in active LXQt session ($SAVED_DISPLAY) for '$USERNAME'"
      fi

      if [[ "$WALLPAPER_UPDATED" -eq 1 && -f "$USER_WALLPAPER" ]] && command -v pcmanfm-qt >/dev/null 2>&1; then
        if [[ "$(id -u)" -eq 0 ]] && command -v runuser >/dev/null 2>&1; then
          runuser -u "$USERNAME" -- env "${ENV_ARGS[@]}" pcmanfm-qt --set-wallpaper="$USER_WALLPAPER" --wallpaper-mode=fit </dev/null >/dev/null 2>&1 || true
        elif [[ "$(id -u)" -eq "$USER_UID" ]]; then
          env "${ENV_ARGS[@]}" pcmanfm-qt --set-wallpaper="$USER_WALLPAPER" --wallpaper-mode=fit </dev/null >/dev/null 2>&1 || true
        fi
      fi
    fi
  fi
fi
