#!/usr/bin/env bash
# Apigee AI Demos — Per-Connect User Session Enforcement Script
#
# Invoked automatically by the server every time a user connects via browser RDP:
#   ./scripts/on-connect.sh <username> <homedir>
#
# Add additional user-environment enforcement steps at the bottom of this script.

set -euo pipefail

USERNAME="${1:?Usage: on-connect.sh <username> [homedir]}"
HOMEDIR="${2:-}"

if [[ -z "$HOMEDIR" ]]; then
  HOMEDIR="$(getent passwd -- "$USERNAME" | cut -d: -f6 || true)"
fi
if [[ -z "$HOMEDIR" ]]; then
  HOMEDIR="/home/$USERNAME"
fi

USER_UID="$(id -u -- "$USERNAME" 2>/dev/null || id -u)"
USER_GID="$(id -g -- "$USERNAME" 2>/dev/null || id -g)"

fix_owner() {
  if [[ "$(id -u)" -eq 0 ]]; then
    chown "$USER_UID:$USER_GID" -- "$1"
  fi
}

ensure_user_dir() {
  local dir="$1"
  if [[ ! -d "$dir" ]]; then
    mkdir -p -- "$dir"
    chmod 0755 -- "$dir"
    fix_owner "$dir"
  fi
}

# ---------------------------------------------------------------------------
# Rule 1: Enforce LXQt default panel Quick Launch favorites (Terminal + Firefox)
# ---------------------------------------------------------------------------
enforce_lxqt_panel_favorites() {
  local apps_dir="${ON_CONNECT_APPS_DIR:-/usr/share/applications}"

  # Detect installed Terminal .desktop launcher on Debian / LXQt
  local term_desktop=""
  local cand
  for cand in \
    "$apps_dir/qterminal.desktop" \
    "$apps_dir/lxterminal.desktop" \
    "$apps_dir/xfce4-terminal.desktop" \
    "$apps_dir/org.gnome.Terminal.desktop" \
    "$apps_dir/konsole.desktop" \
    "$apps_dir/debian-xterm.desktop" \
    "$apps_dir/xterm.desktop"; do
    if [[ -f "$cand" ]]; then
      term_desktop="$cand"
      break
    fi
  done
  if [[ -z "$term_desktop" ]]; then
    term_desktop="$apps_dir/qterminal.desktop"
  fi

  # Detect installed Firefox .desktop launcher on Debian (firefox-esr or firefox)
  local firefox_desktop=""
  for cand in \
    "$apps_dir/firefox-esr.desktop" \
    "$apps_dir/firefox.desktop" \
    "/var/lib/snapd/desktop/applications/firefox_firefox.desktop"; do
    if [[ -f "$cand" ]]; then
      firefox_desktop="$cand"
      break
    fi
  done
  if [[ -z "$firefox_desktop" ]]; then
    firefox_desktop="$apps_dir/firefox-esr.desktop"
  fi

  # Keep Debian LXQt's default file manager in Quick Launch if seeding from an empty list
  local fileman_desktop=""
  if [[ -f "$apps_dir/pcmanfm-qt.desktop" ]]; then
    fileman_desktop="$apps_dir/pcmanfm-qt.desktop"
  fi

  ensure_user_dir "$HOMEDIR"
  ensure_user_dir "$HOMEDIR/.config"
  ensure_user_dir "$HOMEDIR/.config/lxqt"

  local panel_conf="$HOMEDIR/.config/lxqt/panel.conf"
  local tmp_seed=""
  local source_conf="$panel_conf"

  if [[ ! -f "$panel_conf" ]]; then
    tmp_seed="$(mktemp "${TMPDIR:-/tmp}/lxqt-panel-seed.XXXXXX")"
    if [[ -n "${ON_CONNECT_SYSTEM_PANEL_CONF:-}" && -f "${ON_CONNECT_SYSTEM_PANEL_CONF}" ]]; then
      cp -- "${ON_CONNECT_SYSTEM_PANEL_CONF}" "$tmp_seed"
    elif [[ -f "/etc/xdg/lxqt/panel.conf" ]]; then
      cp -- "/etc/xdg/lxqt/panel.conf" "$tmp_seed"
    elif [[ -f "/usr/share/lxqt/panel.conf" ]]; then
      cp -- "/usr/share/lxqt/panel.conf" "$tmp_seed"
    else
      cat >"$tmp_seed" <<'EOF'
[General]
__userfile__=true
panels=panel1

[panel1]
plugins=mainmenu, desktopswitch, quicklaunch, taskbar, tray, statusnotifier, volume, worldclock, showdesktop
position=Bottom

[quicklaunch]
alignment=Left
type=quicklaunch
EOF
    fi
    source_conf="$tmp_seed"
  fi

  render_panel_conf() {
    local input_file="$1"
    local output_file="$2"
    TERM_DESKTOP="$term_desktop" \
    FIREFOX_DESKTOP="$firefox_desktop" \
    FILEMAN_DESKTOP="$fileman_desktop" \
    awk '
      function trim(s) {
        sub(/^[ \t\r]+/, "", s)
        sub(/[ \t\r]+$/, "", s)
        return s
      }
      function basename(p,    n, parts) {
        n = split(p, parts, "/")
        return parts[n]
      }
      function has_app(target,    i, tb) {
        tb = basename(target)
        for (i = 1; i <= app_count; i++) {
          if (apps[i] == target) return 1
          if ((tb == "firefox.desktop" || tb == "firefox-esr.desktop") &&
              (basename(apps[i]) == "firefox.desktop" || basename(apps[i]) == "firefox-esr.desktop")) {
            return 1
          }
        }
        return 0
      }
      function add_app(target) {
        if (target != "" && !has_app(target)) {
          app_count++
          apps[app_count] = target
        }
      }
      function emit_quicklaunch_body(    i) {
        if (!ql_has_alignment) {
          print "alignment=Left"
        }
        if (!ql_has_type) {
          print "type=quicklaunch"
        }
        if (app_count == 0 && ENVIRON["FILEMAN_DESKTOP"] != "") {
          add_app(ENVIRON["FILEMAN_DESKTOP"])
        }
        add_app(ENVIRON["TERM_DESKTOP"])
        add_app(ENVIRON["FIREFOX_DESKTOP"])
        for (i = 1; i <= app_count; i++) {
          print "apps\\" i "\\desktop=" apps[i]
        }
        print "apps\\size=" app_count
      }

      BEGIN {
        section = ""
        saw_general = 0
        general_has_userfile = 0
        saw_quicklaunch = 0
        ql_section_name = "quicklaunch"
        ql_has_alignment = 0
        ql_has_type = 0
        app_count = 0
      }

      {
        line = $0
        sub(/\r$/, "", line)

        if (line ~ /^\[[^]]+\][ \t]*$/) {
          # Close previous section before starting next section
          if (section == "General" && !general_has_userfile) {
            print "__userfile__=true"
            general_has_userfile = 1
          } else if (section == ql_section_name) {
            emit_quicklaunch_body()
          }

          section = line
          sub(/^\[/, "", section)
          sub(/\][ \t]*$/, "", section)

          if (section == "General") {
            saw_general = 1
          } else if (section == ql_section_name) {
            saw_quicklaunch = 1
          }
          print line
          next
        }

        if (section == "General") {
          if (line ~ /^__userfile__[ \t]*=/) {
            print "__userfile__=true"
            general_has_userfile = 1
            next
          }
        }

        if (section == "panel1" && line ~ /^plugins[ \t]*=/) {
          eq = index(line, "=")
          val = substr(line, eq + 1)
          # Detect custom quicklaunch plugin section name or ensure quicklaunch is enabled
          n = split(val, plug_arr, ",")
          found_ql = 0
          for (i = 1; i <= n; i++) {
            p = trim(plug_arr[i])
            if (p ~ /^quicklaunch/) {
              found_ql = 1
              if (!saw_quicklaunch) {
                ql_section_name = p
              }
              break
            }
          }
          if (!found_ql) {
            line = line ", quicklaunch"
          }
          print line
          next
        }

        if (section == ql_section_name) {
          if (line ~ /^apps\\[0-9]+\\desktop=/) {
            eq = index(line, "=")
            desktop_path = trim(substr(line, eq + 1))
            add_app(desktop_path)
            next
          }
          if (line ~ /^apps\\size=/) {
            next
          }
          if (line ~ /^alignment=/) {
            ql_has_alignment = 1
          }
          if (line ~ /^type=/) {
            ql_has_type = 1
          }
          # Skip trailing blank lines inside quicklaunch so generated keys stay grouped cleanly
          if (trim(line) == "") {
            next
          }
          print line
          next
        }

        print line
      }

      END {
        if (section == "General" && !general_has_userfile) {
          print "__userfile__=true"
        } else if (section == ql_section_name) {
          emit_quicklaunch_body()
        }

        if (!saw_quicklaunch) {
          print ""
          print "[" ql_section_name "]"
          emit_quicklaunch_body()
        }
      }
    ' "$input_file" >"$output_file"

    # Prepend [General] with __userfile__=true if the source file lacked [General] completely
    if ! grep -q '^\[General\]' "$output_file"; then
      local with_gen="${output_file}.gen"
      {
        printf '[General]\n__userfile__=true\npanels=panel1\n\n'
        cat "$output_file"
      } >"$with_gen"
      mv -- "$with_gen" "$output_file"
    fi
  }

  local tmp_out
  tmp_out="$(mktemp "$HOMEDIR/.config/lxqt/panel.conf.tmp.XXXXXX")"
  render_panel_conf "$source_conf" "$tmp_out"
  [[ -n "$tmp_seed" ]] && rm -f -- "$tmp_seed"

  # If panel.conf already exists with Terminal + Firefox configured, avoid unnecessary writes/restarts
  if [[ -f "$panel_conf" ]] && cmp -s "$tmp_out" "$panel_conf"; then
    rm -f -- "$tmp_out"
    fix_owner "$panel_conf"
    echo "[on-connect] LXQt panel favorites already up to date for '$USERNAME'"
    return 0
  fi

  # Check if lxqt-panel is currently running in an active session for this user
  local panel_pid=""
  if [[ "${ON_CONNECT_SKIP_PROCESS_CHECK:-0}" != "1" ]] && command -v pgrep >/dev/null 2>&1; then
    panel_pid="$(pgrep -u "$USER_UID" -x lxqt-panel 2>/dev/null | head -n1 || true)"
  fi

  local saved_display=""
  local saved_xauth=""
  local saved_xdg_runtime=""
  local saved_dbus=""

  if [[ -n "$panel_pid" && -r "/proc/$panel_pid/environ" ]]; then
    while IFS='=' read -r -d '' k v; do
      case "$k" in
        DISPLAY) saved_display="$v" ;;
        XAUTHORITY) saved_xauth="$v" ;;
        XDG_RUNTIME_DIR) saved_xdg_runtime="$v" ;;
        DBUS_SESSION_BUS_ADDRESS) saved_dbus="$v" ;;
      esac
    done <"/proc/$panel_pid/environ" || true

    # Stop lxqt-panel BEFORE writing panel.conf so it does not overwrite our changes on exit
    pkill -u "$USER_UID" -x lxqt-panel 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if ! pgrep -u "$USER_UID" -x lxqt-panel >/dev/null 2>&1; then
        break
      fi
      sleep 0.1
    done

    # Re-apply onto panel.conf in case lxqt-panel flushed user layout edits on SIGTERM
    if [[ -f "$panel_conf" ]]; then
      render_panel_conf "$panel_conf" "$tmp_out"
    fi
  fi

  chmod 0644 -- "$tmp_out"
  fix_owner "$tmp_out"
  mv -f -- "$tmp_out" "$panel_conf"
  echo "[on-connect] Updated LXQt panel favorites ($panel_conf) -> $term_desktop, $firefox_desktop"

  # If we stopped a live lxqt-panel and lxqt-session hasn't respawned it automatically, relaunch it
  if [[ -n "$panel_pid" && -n "$saved_display" ]] && command -v lxqt-panel >/dev/null 2>&1; then
    sleep 0.3
    if ! pgrep -u "$USER_UID" -x lxqt-panel >/dev/null 2>&1; then
      local -a env_args=("DISPLAY=$saved_display" "HOME=$HOMEDIR" "USER=$USERNAME" "LOGNAME=$USERNAME")
      [[ -n "$saved_xauth" ]] && env_args+=("XAUTHORITY=$saved_xauth")
      [[ -n "$saved_xdg_runtime" ]] && env_args+=("XDG_RUNTIME_DIR=$saved_xdg_runtime")
      [[ -n "$saved_dbus" ]] && env_args+=("DBUS_SESSION_BUS_ADDRESS=$saved_dbus")

      if [[ "$(id -u)" -eq 0 ]] && command -v runuser >/dev/null 2>&1; then
        runuser -u "$USERNAME" -- env "${env_args[@]}" nohup lxqt-panel >/dev/null 2>&1 &
      elif [[ "$(id -u)" -eq "$USER_UID" ]]; then
        env "${env_args[@]}" nohup lxqt-panel >/dev/null 2>&1 &
      fi
      echo "[on-connect] Reloaded running lxqt-panel on $saved_display for '$USERNAME'"
    fi
  fi
}

enforce_lxqt_panel_favorites
