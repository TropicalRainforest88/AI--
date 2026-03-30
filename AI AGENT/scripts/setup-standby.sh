#!/bin/bash
# setup-standby.sh - One-time provisioning of standby server for OpenClaw HA failover
# Runs FROM local machine, SSHs into standby to set up directory structure,
# watchdog, and systemd units.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Load environment for defaults
if [ -f "$PROJECT_DIR/.env" ]; then
  source "$PROJECT_DIR/.env"
fi

# --- Parse arguments ---
HOST="${STANDBY_HOST:-}"
USER="${STANDBY_USER:-${REMOTE_USER:-hqj}}"
PASSWORD=""

while [ $# -gt 0 ]; do
  case "$1" in
    --host)
      shift
      HOST="${1:-}"
      ;;
    --user)
      shift
      USER="${1:-}"
      ;;
    --password)
      shift
      PASSWORD="${1:-}"
      ;;
    --help)
      echo "Usage: setup-standby.sh [--host <ip>] [--user <user>] [--password <pass>]"
      echo ""
      echo "One-time provisioning of a standby server for OpenClaw HA failover."
      echo ""
      echo "Options:"
      echo "  --host      Standby server hostname/IP (default: STANDBY_HOST from .env)"
      echo "  --user      SSH user (default: STANDBY_USER or REMOTE_USER from .env)"
      echo "  --password  SSH password (uses sshpass; optional if key-based auth)"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
  shift
done

if [ -z "$HOST" ]; then
  echo "ERROR: No host specified. Use --host <ip> or set STANDBY_HOST in .env"
  exit 1
fi

REMOTE="${USER}@${HOST}"

echo "=== OpenClaw Standby Setup ==="
echo "  Target: ${REMOTE}"
echo ""

# --- SSH Multiplexing ---
SSH_CONTROL="/tmp/setup-standby-ssh-$$"

cleanup_ssh() {
  ssh -o ControlPath="$SSH_CONTROL" -O exit "${REMOTE}" 2>/dev/null || true
}
trap cleanup_ssh EXIT

echo "[0/8] Establishing SSH connection to ${REMOTE}..."
if [ -n "${PASSWORD}" ]; then
  if ! command -v sshpass &>/dev/null; then
    echo "ERROR: --password requires sshpass but it is not installed"
    exit 1
  fi
  SSHPASS="$PASSWORD" sshpass -e ssh -o StrictHostKeyChecking=no \
    -o ControlMaster=yes -o ControlPath="$SSH_CONTROL" -o ControlPersist=300 \
    -fN "${REMOTE}"
elif [ -n "${SSHPASS:-}" ]; then
  sshpass -e ssh -o StrictHostKeyChecking=no \
    -o ControlMaster=yes -o ControlPath="$SSH_CONTROL" -o ControlPersist=300 \
    -fN "${REMOTE}"
else
  ssh -o StrictHostKeyChecking=no \
    -o ControlMaster=yes -o ControlPath="$SSH_CONTROL" -o ControlPersist=300 \
    -fN "${REMOTE}"
fi

SSH="ssh -o ControlPath=$SSH_CONTROL"
SCP="scp -o ControlPath=$SSH_CONTROL"

echo "  -> SSH connection established"
echo ""

# --- Step 1: Check prerequisites ---
echo "[1/8] Checking prerequisites on remote..."

if ! $SSH "$REMOTE" "command -v node" &>/dev/null; then
  echo "ERROR: Node.js is not installed on ${REMOTE}."
  echo "Please install Node.js manually (e.g., via nvm or package manager) and re-run."
  exit 1
fi
echo "  -> node: $($SSH "$REMOTE" "node --version")"

if ! $SSH "$REMOTE" "command -v openclaw || npm list -g openclaw 2>/dev/null" &>/dev/null; then
  echo "  openclaw not found, installing..."
  $SSH "$REMOTE" "npm install -g openclaw@2026.3.12"
  echo "  -> openclaw installed"
else
  echo "  -> openclaw: already installed"
fi
echo ""

# --- Step 2: Create directory structure ---
echo "[2/8] Creating directory structure on remote..."
BASE="${OPENCLAW_BASE:-/home/${USER}/.openclaw}"

$SSH "$REMOTE" "mkdir -p ${BASE}/{secrets,soul,cron,watchdog} && \
  for ws in cams-cryp-pre cams-cryp-ol onepay gb-ol openclaw-coderevie-ol; do \
    mkdir -p ${BASE}/workspace-\${ws}/skills; \
  done"
echo "  -> directory structure created at ${BASE}"
echo ""

# --- Step 3: Upload watchdog script ---
echo "[3/8] Uploading watchdog script..."
$SCP "$PROJECT_DIR/watchdog/watchdog.sh" "$REMOTE:${BASE}/watchdog/watchdog.sh"
$SSH "$REMOTE" "chmod +x ${BASE}/watchdog/watchdog.sh"
echo "  -> watchdog.sh uploaded"
echo ""

# --- Step 4: Install systemd user units ---
echo "[4/8] Installing systemd user units..."
$SSH "$REMOTE" "mkdir -p ~/.config/systemd/user"
$SCP "$PROJECT_DIR/watchdog/openclaw-watchdog.service" "$REMOTE:~/.config/systemd/user/openclaw-watchdog.service"
$SCP "$PROJECT_DIR/watchdog/openclaw-watchdog.timer" "$REMOTE:~/.config/systemd/user/openclaw-watchdog.timer"
echo "  -> systemd units installed"
echo ""

# --- Step 5: Create watchdog.env ---
echo "[5/8] Configuring watchdog.env..."

BOT_TOKEN="${WATCHDOG_BOT_TOKEN:-}"
CHAT_ID="${WATCHDOG_CHAT_ID:-}"
PRIMARY="${REMOTE_HOST:-100.127.134.23}"
PRIMARY_USER="${REMOTE_USER:-hqj}"

if [ -z "$BOT_TOKEN" ]; then
  read -p "  Telegram Bot Token: " BOT_TOKEN
fi
if [ -z "$CHAT_ID" ]; then
  read -p "  Telegram Alert Chat ID: " CHAT_ID
fi

printf 'PRIMARY_HOST=%s\nPRIMARY_PORT=18789\nBOT_TOKEN=%s\nALERT_CHAT_ID=%s\nPRIMARY_SSH_USER=%s\n' \
  "$PRIMARY" "$BOT_TOKEN" "$CHAT_ID" "$PRIMARY_USER" \
  | $SSH "$REMOTE" "cat > ${BASE}/watchdog/watchdog.env && chmod 600 ${BASE}/watchdog/watchdog.env"
echo "  -> watchdog.env created (chmod 600)"
echo ""

# --- Step 6: Configure systemd ---
echo "[6/8] Configuring systemd services..."
$SSH "$REMOTE" "systemctl --user daemon-reload && \
  systemctl --user disable openclaw-gateway.service 2>/dev/null || true && \
  systemctl --user stop openclaw-gateway.service 2>/dev/null || true && \
  systemctl --user enable openclaw-watchdog.timer && \
  systemctl --user start openclaw-watchdog.timer"
echo "  -> watchdog timer enabled and started"
echo "  -> gateway service disabled (standby mode)"
echo ""

# --- Step 7: Enable lingering for user systemd ---
echo "[7/8] Enabling loginctl linger (persist user services after logout)..."
$SSH "$REMOTE" "loginctl enable-linger ${USER} 2>/dev/null || echo '  (linger may require sudo — verify manually)'"
echo ""

# --- Step 8: Print status ---
echo "[8/8] Verifying setup..."
echo ""
echo "=== Setup Complete ==="
$SSH "$REMOTE" "systemctl --user status openclaw-watchdog.timer --no-pager" || true
echo ""
echo "Next steps:"
echo "  1. Run: scripts/deploy.sh --target standby"
echo "  2. Verify: ssh ${USER}@${HOST} 'systemctl --user status openclaw-watchdog.timer'"
