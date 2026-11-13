#!/usr/bin/env bash
# Register or deregister the Apigee AI Demos systemd service on Debian 13.
#
# Usage:
#   sudo ./scripts/systemd-service.sh register [--dir /path/to/rdp-web] [--bun | --binary]
#   sudo ./scripts/systemd-service.sh deregister

set -euo pipefail

SERVICE_NAME="apigee-ai-demos"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
EXEC_MODE="auto"

usage() {
  cat <<EOF
Usage:
  sudo $0 register [--dir <app-dir>] [--binary | --bun]
  sudo $0 deregister

Commands:
  register     Write ${UNIT_PATH}, reload systemd, and enable ${SERVICE_NAME}.service
  deregister   Stop, disable, and remove ${UNIT_PATH}, then reload systemd

Options:
  --dir <dir>  Working directory for the service (default: ${APP_DIR})
  --binary     Force ExecStart to <app-dir>/apigee-ai-demos
  --bun        Force ExecStart to <bun> run src/server.ts
  -h, --help   Show this help message
EOF
}

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "Error: this script must be run as root (e.g. sudo $0 $*)" >&2
    exit 1
  fi
}

print_control_commands() {
  cat <<EOF

Service management commands:
  Start:    sudo systemctl start ${SERVICE_NAME}
  Stop:     sudo systemctl stop ${SERVICE_NAME}
  Restart:  sudo systemctl restart ${SERVICE_NAME}
  Status:   sudo systemctl status ${SERVICE_NAME}
  Logs:     sudo journalctl -u ${SERVICE_NAME} -f
EOF
}

ACTION="${1:-}"
if [[ -z "$ACTION" || "$ACTION" == "-h" || "$ACTION" == "--help" ]]; then
  usage
  exit 0
fi
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      APP_DIR="${2:?--dir requires a path}"
      shift 2
      ;;
    --binary)
      EXEC_MODE="binary"
      shift
      ;;
    --bun)
      EXEC_MODE="bun"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

case "$ACTION" in
  register|install)
    require_root "$ACTION"
    APP_DIR="$(cd -- "$APP_DIR" && pwd)"

    if [[ "$EXEC_MODE" == "auto" ]]; then
      if [[ -x "$APP_DIR/apigee-ai-demos" ]]; then
        EXEC_MODE="binary"
      else
        EXEC_MODE="bun"
      fi
    fi

    if [[ "$EXEC_MODE" == "binary" ]]; then
      if [[ ! -x "$APP_DIR/apigee-ai-demos" ]]; then
        echo "Error: compiled binary not found or not executable at $APP_DIR/apigee-ai-demos" >&2
        echo "Run 'bun run build' first or pass --bun." >&2
        exit 1
      fi
      EXEC_START="${APP_DIR}/apigee-ai-demos"
    else
      BUN_BIN="$(command -v bun || true)"
      if [[ -z "$BUN_BIN" && -x /usr/local/bin/bun ]]; then
        BUN_BIN="/usr/local/bin/bun"
      fi
      if [[ -z "$BUN_BIN" || ! -x "$BUN_BIN" ]]; then
        echo "Error: 'bun' binary not found in PATH or /usr/local/bin/bun" >&2
        exit 1
      fi
      if [[ ! -f "$APP_DIR/src/server.ts" ]]; then
        echo "Error: $APP_DIR/src/server.ts not found" >&2
        exit 1
      fi
      EXEC_START="${BUN_BIN} run src/server.ts"
    fi

    cat >"$UNIT_PATH" <<EOF
[Unit]
Description=Apigee AI Demos Web Portal & xrdp Gateway
After=network-online.target xrdp.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
EnvironmentFile=-${APP_DIR}/.env
ExecStart=${EXEC_START}
Restart=on-failure
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
EOF
    chmod 0644 "$UNIT_PATH"

    systemctl daemon-reload
    systemctl enable "${SERVICE_NAME}.service"

    echo "Registered and enabled ${SERVICE_NAME}.service -> ${UNIT_PATH}"
    echo "  WorkingDirectory: ${APP_DIR}"
    echo "  ExecStart:        ${EXEC_START}"
    print_control_commands
    ;;

  deregister|uninstall|remove)
    require_root "$ACTION"
    if systemctl is-active --quiet "${SERVICE_NAME}.service" 2>/dev/null; then
      systemctl stop "${SERVICE_NAME}.service"
    fi
    if systemctl is-enabled --quiet "${SERVICE_NAME}.service" 2>/dev/null; then
      systemctl disable "${SERVICE_NAME}.service"
    fi
    rm -f -- "$UNIT_PATH"
    systemctl daemon-reload
    systemctl reset-failed "${SERVICE_NAME}.service" 2>/dev/null || true

    echo "Deregistered and removed ${UNIT_PATH}"
    ;;

  *)
    echo "Unknown command: $ACTION" >&2
    usage >&2
    exit 1
    ;;
esac
