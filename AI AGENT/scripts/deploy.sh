#!/bin/bash
# deploy.sh - Deploy OpenClaw configuration to remote server(s)
# Supports primary, standby, or both (HA dual-host deployment)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Load environment
if [ -f "$PROJECT_DIR/.env" ]; then
  source "$PROJECT_DIR/.env"
else
  echo "ERROR: .env file not found. Copy .env.example to .env and fill in values."
  exit 1
fi

BASE="${OPENCLAW_BASE}"

# --- Host configuration ---
PRIMARY_REMOTE="${REMOTE_USER}@${REMOTE_HOST}"
STANDBY_REMOTE="${STANDBY_USER:-$REMOTE_USER}@${STANDBY_HOST:-}"

SSH_CONTROL_PRIMARY="/tmp/deploy-ssh-primary-$$"
SSH_CONTROL_STANDBY="/tmp/deploy-ssh-standby-$$"

# --- SSH Multiplexing ---
cleanup_ssh() {
  ssh -o ControlPath="$SSH_CONTROL_PRIMARY" -O exit "${PRIMARY_REMOTE}" 2>/dev/null || true
  if [ -n "${STANDBY_HOST:-}" ]; then
    ssh -o ControlPath="$SSH_CONTROL_STANDBY" -O exit "${STANDBY_REMOTE}" 2>/dev/null || true
  fi
}
trap cleanup_ssh EXIT

# --- Parse arguments ---
DEPLOY_ALL=false
DEPLOY_CONFIG=false
DEPLOY_SKILLS=false
DEPLOY_SOUL=false
DEPLOY_CRON=false
DEPLOY_SECRETS=false
RESTART=false
NEEDS_RESTART=false
RESTART_FLAG_FILE=$(mktemp)
echo "false" > "$RESTART_FLAG_FILE"
DEPLOY_TARGET="both"

if [ $# -eq 0 ]; then
  DEPLOY_ALL=true
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --all)      DEPLOY_ALL=true ;;
    --config)   DEPLOY_CONFIG=true ;;
    --skills)   DEPLOY_SKILLS=true ;;
    --soul)     DEPLOY_SOUL=true ;;
    --cron)     DEPLOY_CRON=true ;;
    --secrets)  DEPLOY_SECRETS=true ;;
    --restart)  RESTART=true ;;
    --target)
      shift
      DEPLOY_TARGET="${1:-both}"
      if [[ "$DEPLOY_TARGET" != "primary" && "$DEPLOY_TARGET" != "standby" && "$DEPLOY_TARGET" != "both" ]]; then
        echo "ERROR: --target must be 'primary', 'standby', or 'both'"
        exit 1
      fi
      ;;
    --help)
      echo "Usage: deploy.sh [--all|--config|--skills|--soul|--cron|--secrets] [--restart] [--target primary|standby|both]"
      echo "  --all      Deploy everything (default if no args)"
      echo "  --config   Deploy openclaw.json"
      echo "  --skills   Deploy skills directory"
      echo "  --soul     Deploy SOUL.md files"
      echo "  --cron     Setup cron jobs (daily digest)"
      echo "  --secrets  Deploy secrets files (ELK credentials, Jira token)"
      echo "  --restart  Restart gateway after deploy"
      echo "  --target   Deploy target: 'primary', 'standby', or 'both' (default: both)"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
  shift
done

if $DEPLOY_ALL; then
  DEPLOY_CONFIG=true
  DEPLOY_SKILLS=true
  DEPLOY_SOUL=true
  DEPLOY_CRON=true
  DEPLOY_SECRETS=true
fi

# Auto-determine restart need (config/skills require gateway reload)
if $DEPLOY_CONFIG || $DEPLOY_SKILLS; then
  NEEDS_RESTART=true
fi

# --- Establish SSH connections ---
establish_ssh() {
  local label="$1"
  local control="$2"
  local remote="$3"
  local use_sshpass="${4:-}"
  local max_retries=3

  # Clean up stale control socket from previous runs
  rm -f "$control"

  echo "Establishing SSH connection to ${label} (${remote})..."
  if [ -n "${use_sshpass}" ] && command -v sshpass &>/dev/null; then
    SSHPASS="$use_sshpass" sshpass -e ssh -o StrictHostKeyChecking=no \
      -o ControlMaster=yes -o ControlPath="$control" -o ControlPersist=300 \
      -fN "${remote}"
  else
    ssh -o StrictHostKeyChecking=no \
      -o ControlMaster=yes -o ControlPath="$control" -o ControlPersist=300 \
      -fN "${remote}"
  fi

  # Verify the master connection is actually ready
  local attempt=0
  while [ $attempt -lt $max_retries ]; do
    if ssh -o ControlPath="$control" -O check "${remote}" 2>/dev/null; then
      echo "  SSH connection to ${label} verified."
      return 0
    fi
    attempt=$((attempt + 1))
    echo "  Waiting for SSH master connection (attempt ${attempt}/${max_retries})..."
    sleep 2
  done

  echo "ERROR: Failed to establish SSH master connection to ${label} after ${max_retries} attempts."
  exit 1
}

if [ "$DEPLOY_TARGET" = "primary" ] || [ "$DEPLOY_TARGET" = "both" ]; then
  establish_ssh "primary" "$SSH_CONTROL_PRIMARY" "$PRIMARY_REMOTE" "${SSHPASS:-}"
fi

if [ "$DEPLOY_TARGET" = "standby" ] || [ "$DEPLOY_TARGET" = "both" ]; then
  if [ -n "${STANDBY_HOST:-}" ]; then
    establish_ssh "standby" "$SSH_CONTROL_STANDBY" "$STANDBY_REMOTE" "${SSHPASS_STANDBY:-}"
  fi
fi

echo "=== OpenClaw Deploy ==="
echo "Target mode: ${DEPLOY_TARGET}"
echo ""

# --- deploy_to_host function ---
# Arguments: host_label ssh_control remote role standby_state
deploy_to_host() {
  local host_label="$1"
  local ssh_control="$2"
  local remote="$3"
  local role="$4"
  local standby_state="${5:-}"

  local ssh_cmd="ssh -o ControlPath=$ssh_control"
  local scp_cmd="scp -o ControlPath=$ssh_control"
  local rsync_ssh="ssh -o ControlPath=$ssh_control"

  echo "  Host: ${remote} | Role: ${role}"
  if [ "$role" = "standby" ]; then
    echo "  Watchdog state: ${standby_state}"
  fi
  echo ""

  # Deploy config
  if $DEPLOY_CONFIG; then
    echo "  [1/5] Deploying openclaw.json..."

    TEMP_CONFIG=$(mktemp)
    sed -e "s|__TELEGRAM_BOT_TOKEN__|${TELEGRAM_BOT_TOKEN}|g" \
        -e "s|__GATEWAY_AUTH_TOKEN__|${GATEWAY_AUTH_TOKEN}|g" \
        -e "s|__SETTLEMENT_TG_GROUP__|${SETTLEMENT_TG_GROUP}|g" \
        "$PROJECT_DIR/config/openclaw.json" > "$TEMP_CONFIG"

    $scp_cmd "$TEMP_CONFIG" "${remote}:${BASE}/openclaw.json"
    rm -f "$TEMP_CONFIG"
    echo "    -> openclaw.json deployed"
  fi

  # Deploy skills (per-workspace isolation)
  if $DEPLOY_SKILLS; then
    echo "  [2/5] Deploying skills to agent workspaces..."

    $ssh_cmd "${remote}" "for ws in cams-cryp-pre cams-cryp-ol onepay onepay-internal onepay-external gb-ol openclaw-coderevie-ol settlement; do mkdir -p ${BASE}/workspace-\${ws}/skills; done"

    RSYNC_PIDS=()
    for ws in cams-cryp-pre cams-cryp-ol onepay onepay-internal onepay-external gb-ol openclaw-coderevie-ol settlement; do
      echo "    Syncing workspace-${ws}/skills/..."
      rsync -avz --delete \
        -e "$rsync_ssh" \
        "$PROJECT_DIR/workspaces/${ws}/skills/" \
        "${remote}:${BASE}/workspace-${ws}/skills/" &
      RSYNC_PIDS+=($!)
    done
    for pid in "${RSYNC_PIDS[@]}"; do
      wait "$pid"
    done

    # Inject ELK MCP token into gb-ol skill
    if [ -n "${ELK_MCP_TOKEN:-}" ]; then
      echo "    Injecting ELK_MCP_TOKEN into gb-ol skill..."
      ELK_MCP_TOKEN_ESCAPED=$(printf '%s' "${ELK_MCP_TOKEN}" | sed 's/[&|]/\\&/g')
      $ssh_cmd "${remote}" "sed -i 's|__ELK_MCP_TOKEN__|${ELK_MCP_TOKEN_ESCAPED}|g' ${BASE}/workspace-gb-ol/skills/elk-log-query/SKILL.md"
    fi

    # Inject GitHub App private key for openclaw-coderevie-ol
    if [ -n "${REVIEWER_APP_PRIVATE_KEY_BASE64:-}" ]; then
      echo "    Injecting GitHub App private key for openclaw-coderevie-ol..."
      TEMP_APP_KEY=$(mktemp)
      printf '%s' "${REVIEWER_APP_PRIVATE_KEY_BASE64}" | base64 -d > "$TEMP_APP_KEY"
      $ssh_cmd "${remote}" "mkdir -p ${BASE}/secrets"
      $scp_cmd "$TEMP_APP_KEY" "${remote}:${BASE}/secrets/github-app.pem"
      rm -f "$TEMP_APP_KEY"
      $ssh_cmd "${remote}" "chmod 600 ${BASE}/secrets/github-app.pem && sed -i 's|__GITHUB_APP_KEY_PATH__|${BASE}/secrets/github-app.pem|g' ${BASE}/workspace-openclaw-coderevie-ol/skills/code-review/SKILL.md"
    fi

    # Inject settlement-bot .env (ES credentials, TG bot token)
    if [ -n "${TG_BOT_TOKEN_SETTLEMENT:-}" ]; then
      echo "    Injecting settlement-bot .env..."
      $ssh_cmd "${remote}" "cat > ${BASE}/workspace-settlement/.env && chmod 600 ${BASE}/workspace-settlement/.env" <<SETTLEMENT_ENV
TG_BOT_TOKEN=${TG_BOT_TOKEN_SETTLEMENT}
ES_HOST=${ES_HOST_SETTLEMENT:-${ES_HOST:-localhost}}
ES_PORT=${ES_PORT_SETTLEMENT:-9200}
ES_USER=${ES_USER_SETTLEMENT:-elastic}
ES_PASS=${ES_PASS_SETTLEMENT:-${ES_PASS:-}}
TG_FORWARD_GROUP=${TG_FORWARD_GROUP_SETTLEMENT:-0}
SETTLEMENT_ENV
    fi

    # Deploy per-agent OpenAI API keys
    # Agent -> env var mapping (all agents must be listed here)
    local -a AGENT_KEY_MAP=(
      "main:OPENAI_API_KEY_MAIN"
      "cams-cryp-pre:OPENAI_API_KEY_CAMS"
      "cams-cryp-ol:OPENAI_API_KEY_CAMS"
      "onepay:OPENAI_API_KEY_ONEPAY"
      "onepay-internal:OPENAI_API_KEY_ONEPAY"
      "onepay-external:OPENAI_API_KEY_ONEPAY"
      "gb-ol:OPENAI_API_KEY_GB_OL"
      "openclaw-coderevie-ol:OPENAI_API_KEY_CODEREVIE_OL"
      "settlement:OPENAI_API_KEY_SETTLEMENT"
    )
    for agent_key_pair in "${AGENT_KEY_MAP[@]}"; do
      agent_id="${agent_key_pair%%:*}"
      env_var="${agent_key_pair##*:}"
      key_value="${!env_var:-}"
      if [ -n "${key_value}" ]; then
        echo "    Injecting OpenAI API key for ${agent_id}..."
        $ssh_cmd "${remote}" "mkdir -p ${BASE}/agents/${agent_id}/agent && printf '{\"version\":1,\"profiles\":{\"openai:default\":{\"type\":\"api_key\",\"provider\":\"openai\",\"key\":\"%s\"}}}' '${key_value}' > ${BASE}/agents/${agent_id}/agent/auth-profiles.json && chmod 600 ${BASE}/agents/${agent_id}/agent/auth-profiles.json"
      fi
    done

    echo "    -> skills deployed"
  fi

  # Deploy SOUL.md
  if $DEPLOY_SOUL; then
    echo "  [3/5] Deploying SOUL.md files..."

    $ssh_cmd "${remote}" "mkdir -p ${BASE}/workspace-cams-cryp-pre ${BASE}/workspace-cams-cryp-ol ${BASE}/workspace-onepay ${BASE}/workspace-onepay-internal ${BASE}/workspace-onepay-external ${BASE}/workspace-gb-ol ${BASE}/workspace-openclaw-coderevie-ol ${BASE}/workspace-settlement ${BASE}/workspace-onepay/docs ${BASE}/workspace-onepay-internal/docs ${BASE}/workspace-onepay-external/docs"

    # Stage SOUL.md files into temp directory for single rsync
    SOUL_STAGE=$(mktemp -d)
    for ws in cams-cryp-pre cams-cryp-ol onepay onepay-internal onepay-external gb-ol openclaw-coderevie-ol settlement; do
      mkdir -p "${SOUL_STAGE}/workspace-${ws}"
      cp "$PROJECT_DIR/workspaces/${ws}/SOUL.md" "${SOUL_STAGE}/workspace-${ws}/SOUL.md"
    done

    rsync -avz \
      -e "$rsync_ssh" \
      "${SOUL_STAGE}/" "${remote}:${BASE}/"
    rm -rf "$SOUL_STAGE"

    # onepay/docs sync (shared with onepay-internal and onepay-external)
    for ws in onepay onepay-internal onepay-external; do
      rsync -avz \
        -e "$rsync_ssh" \
        "$PROJECT_DIR/workspaces/onepay/docs/" \
        "${remote}:${BASE}/workspace-${ws}/docs/"
    done
    echo "    -> SOUL.md files deployed"
  fi

  # Deploy secrets
  if $DEPLOY_SECRETS; then
    echo "  [4/5] Deploying secrets..."

    TEMP_PLATFORMS=$(mktemp)
    printf '%s' "${ONEPAY_PLATFORMS_JSON}" | base64 -d > "$TEMP_PLATFORMS"
    $scp_cmd "$TEMP_PLATFORMS" "${remote}:/tmp/onepay-platforms.json"
    rm -f "$TEMP_PLATFORMS"

    $ssh_cmd "${remote}" "
      mkdir -p ${BASE}/secrets && chmod 700 ${BASE}/secrets
      printf 'export ELK_USER=%s\nexport ELK_PASS=%s\n' '${ELK_USER}' '${ELK_PASS}' > ${BASE}/secrets/elk.sh && chmod 600 ${BASE}/secrets/elk.sh
      printf 'export JIRA_URL=https://jira.1-pay.co\nexport JIRA_TOKEN=%s\n' '${JIRA_TOKEN}' > ${BASE}/secrets/jira.sh && chmod 600 ${BASE}/secrets/jira.sh
      printf 'export OPENAI_ADMIN_API_KEY=%s\n' '${OPENAI_ADMIN_API_KEY}' > ${BASE}/secrets/openai-admin.sh && chmod 600 ${BASE}/secrets/openai-admin.sh
      mkdir -p ${BASE}/workspace/secrets
      mv /tmp/onepay-platforms.json ${BASE}/workspace/secrets/onepay-platforms.json
      chmod 600 ${BASE}/workspace/secrets/onepay-platforms.json
    "
    # Settlement-bot .env (also deployed during --secrets)
    if [ -n "${TG_BOT_TOKEN_SETTLEMENT:-}" ]; then
      echo "    Deploying settlement-bot .env..."
      $ssh_cmd "${remote}" "mkdir -p ${BASE}/workspace-settlement && cat > ${BASE}/workspace-settlement/.env && chmod 600 ${BASE}/workspace-settlement/.env" <<SETTLEMENT_ENV
TG_BOT_TOKEN=${TG_BOT_TOKEN_SETTLEMENT}
ES_HOST=${ES_HOST_SETTLEMENT:-${ES_HOST:-localhost}}
ES_PORT=${ES_PORT_SETTLEMENT:-9200}
ES_USER=${ES_USER_SETTLEMENT:-elastic}
ES_PASS=${ES_PASS_SETTLEMENT:-${ES_PASS:-}}
TG_FORWARD_GROUP=${TG_FORWARD_GROUP_SETTLEMENT:-0}
SETTLEMENT_ENV
    fi
    echo "    -> secrets deployed (elk.sh, jira.sh, openai-admin.sh, onepay-platforms.json, settlement .env)"
  fi

  # Deploy cron jobs
  if $DEPLOY_CRON; then
    echo "  [5/5] Deploying cron jobs..."

    TEMP_CRON=$(mktemp)
    sed -e "s|__JIRA_TOKEN__|${JIRA_TOKEN}|g" \
        "$PROJECT_DIR/config/cron-jobs.json" > "$TEMP_CRON"

    # For standby in STANDBY state: disable all cron jobs
    if [ "$role" = "standby" ] && [ "$standby_state" = "STANDBY" ]; then
      echo "    (Standby mode: disabling all cron jobs)"
      sed -i.bak 's/"enabled": true/"enabled": false/g' "$TEMP_CRON"
      rm -f "${TEMP_CRON}.bak"
    fi

    $ssh_cmd "${remote}" "mkdir -p ${BASE}/cron"
    $scp_cmd "$TEMP_CRON" "${remote}:${BASE}/cron/jobs.json"
    rm -f "$TEMP_CRON"

    # Deploy digest scripts and config
    $ssh_cmd "${remote}" "mkdir -p ${BASE}/scripts ${BASE}/config"
    $scp_cmd "$PROJECT_DIR/scripts/daily-digest.sh" "${remote}:${BASE}/scripts/daily-digest.sh"
    $scp_cmd "$PROJECT_DIR/scripts/daily-digest-collect.py" "${remote}:${BASE}/scripts/daily-digest-collect.py"
    $ssh_cmd "${remote}" "chmod +x ${BASE}/scripts/daily-digest.sh"
    $scp_cmd "$PROJECT_DIR/config/agent-projects.json" "${remote}:${BASE}/config/agent-projects.json"
    echo "    -> cron jobs and digest scripts deployed"
  fi

  # Reset sessions after skills/soul deploy to avoid stale context
  if $DEPLOY_SKILLS || $DEPLOY_SOUL; then
    echo ""
    echo "  Resetting agent sessions (JSONL transcripts preserved)..."
    $ssh_cmd "${remote}" 'bash -l -c "
      for store in '"${BASE}"'/agents/*/sessions/sessions.json; do
        [ -f \"\$store\" ] || continue
        agent=\$(basename \$(dirname \$(dirname \"\$store\")))
        cp \"\$store\" \"\$store.bak\"
        echo \"{}\" > \"\$store\"
        echo \"    -> \$agent: sessions reset (backup: sessions.json.bak)\"
      done
    "'
  fi

  # Watchdog sync for standby (script, units, env)
  if [ "$role" = "standby" ]; then
    echo "  Syncing watchdog artifacts..."
    $ssh_cmd "${remote}" "mkdir -p ${BASE}/watchdog ~/.config/systemd/user"

    # Sync watchdog script and systemd units
    $scp_cmd "$PROJECT_DIR/watchdog/watchdog.sh" "${remote}:${BASE}/watchdog/watchdog.sh"
    $ssh_cmd "${remote}" "chmod +x ${BASE}/watchdog/watchdog.sh"
    $scp_cmd "$PROJECT_DIR/watchdog/openclaw-watchdog.service" "${remote}:~/.config/systemd/user/openclaw-watchdog.service"
    $scp_cmd "$PROJECT_DIR/watchdog/openclaw-watchdog.timer" "${remote}:~/.config/systemd/user/openclaw-watchdog.timer"
    $ssh_cmd "${remote}" "systemctl --user daemon-reload"
    echo "    -> watchdog script and units synced"

    # Sync watchdog.env
    echo "  Syncing watchdog.env..."
    printf 'PRIMARY_HOST=%s\nPRIMARY_PORT=18789\nBOT_TOKEN=%s\nALERT_CHAT_ID=%s\nPRIMARY_SSH_USER=%s\n' \
      "${REMOTE_HOST}" "${WATCHDOG_BOT_TOKEN:-}" "${WATCHDOG_CHAT_ID:-}" "${REMOTE_USER}" \
      | $ssh_cmd "${remote}" "cat > ${BASE}/watchdog/watchdog.env && chmod 600 ${BASE}/watchdog/watchdog.env"

    echo "  Verifying watchdog timer..."
    $ssh_cmd "${remote}" "systemctl --user is-active openclaw-watchdog.timer 2>/dev/null && echo '    -> watchdog timer is running' || echo '    WARNING: watchdog timer is NOT running'"
  fi

  # Restart gateway
  if $RESTART || $NEEDS_RESTART; then
    if [ "$role" = "standby" ] && [ "$standby_state" = "STANDBY" ]; then
      echo ""
      echo "  Skipping gateway restart (standby in STANDBY state)"
    else
      echo ""
      echo "  Restarting OpenClaw gateway..."
      $ssh_cmd "${remote}" "systemctl --user restart openclaw-gateway.service 2>/dev/null || (cd ${BASE} && openclaw gateway restart 2>/dev/null) || echo 'Please restart gateway manually'"
      echo "    -> Gateway restart requested"

      # Restore ACL after gateway restart (OpenClaw forces .openclaw to 0700)
      # OpenClaw creates files with mode 0600, which sets ACL mask to ---,
      # effectively nullifying inherited ACL entries. We must also fix the mask.
      echo "  Restoring ACL for openclaw-reader..."
      if $ssh_cmd "${remote}" "sleep 2 && setfacl -m u:openclaw-reader:rx ${BASE} && setfacl -R -m u:openclaw-reader:rX ${BASE} && setfacl -R -d -m u:openclaw-reader:rX ${BASE} && setfacl -R -m m::rX ${BASE}" 2>/dev/null; then
        echo "    -> ACL restored (including default ACL and mask fix for new files)"
      else
        echo "    WARNING: ACL restore failed (acl package may not be installed)"
      fi

      # Install crontab to periodically fix ACL mask on new files created by OpenClaw
      # (OpenClaw creates files with mode 0600 → ACL mask becomes --- → openclaw-reader blocked)
      echo "  Installing ACL mask fix crontab..."
      $ssh_cmd "${remote}" "
        CRON_ENTRY='*/5 * * * * /usr/bin/setfacl -R -m m::rX ${BASE}/agents 2>/dev/null && /usr/bin/setfacl -R -m m::rX ${BASE}/logs 2>/dev/null # openclaw-acl-mask-fix'
        (crontab -l 2>/dev/null | grep -v 'openclaw-acl-mask-fix'; echo \"\$CRON_ENTRY\") | crontab -
      " 2>/dev/null && echo "    -> ACL mask fix crontab installed (every 5 min)" || echo "    WARNING: crontab install failed"

      # Safe for concurrent writes: both subshells write identical content ("true")
      echo "true" > "$RESTART_FLAG_FILE"
    fi
  fi
}

# --- Execute deployment ---
DEPLOY_FAIL=false

if [ "$DEPLOY_TARGET" = "both" ] && [ -n "${STANDBY_HOST:-}" ]; then
  # Parallel deployment to both servers
  LOG_PRIMARY=$(mktemp)
  LOG_STANDBY=$(mktemp)

  echo "=== Deploying to PRIMARY ($REMOTE_HOST) and STANDBY ($STANDBY_HOST) in parallel ==="

  # Get standby state before parallel execution
  standby_state=$(ssh -o ControlPath="$SSH_CONTROL_STANDBY" "${STANDBY_REMOTE}" "cat \$HOME/.local/state/openclaw-watchdog/state 2>/dev/null || echo STANDBY")

  deploy_to_host "primary" "$SSH_CONTROL_PRIMARY" "$PRIMARY_REMOTE" "primary" "" > "$LOG_PRIMARY" 2>&1 &
  PID_PRIMARY=$!

  deploy_to_host "standby" "$SSH_CONTROL_STANDBY" "$STANDBY_REMOTE" "standby" "$standby_state" > "$LOG_STANDBY" 2>&1 &
  PID_STANDBY=$!

  # Wait for both (capture exit codes without set -e tripping)
  PRIMARY_EXIT=0
  STANDBY_EXIT=0
  wait "$PID_PRIMARY" || PRIMARY_EXIT=$?
  wait "$PID_STANDBY" || STANDBY_EXIT=$?

  # Print logs in order
  echo "--- PRIMARY ---"
  cat "$LOG_PRIMARY"
  echo ""
  echo "--- STANDBY (watchdog state: $standby_state) ---"
  cat "$LOG_STANDBY"
  echo ""

  rm -f "$LOG_PRIMARY" "$LOG_STANDBY"

  if [ "$PRIMARY_EXIT" -ne 0 ]; then
    echo "ERROR: Primary deployment failed (exit $PRIMARY_EXIT)"
    DEPLOY_FAIL=true
  fi
  if [ "$STANDBY_EXIT" -ne 0 ]; then
    echo "ERROR: Standby deployment failed (exit $STANDBY_EXIT)"
    DEPLOY_FAIL=true
  fi
else
  # Single-target deployment (serial)
  if [ "$DEPLOY_TARGET" = "primary" ] || [ "$DEPLOY_TARGET" = "both" ]; then
    echo "=== Deploying to PRIMARY ($REMOTE_HOST) ==="
    deploy_to_host "primary" "$SSH_CONTROL_PRIMARY" "$PRIMARY_REMOTE" "primary" "" || DEPLOY_FAIL=true
    echo ""
  fi

  if [ "$DEPLOY_TARGET" = "standby" ] || [ "$DEPLOY_TARGET" = "both" ]; then
    if [ -z "${STANDBY_HOST:-}" ]; then
      echo "WARNING: STANDBY_HOST not set, skipping standby deployment"
    else
      echo "=== Deploying to STANDBY ($STANDBY_HOST) ==="
      standby_state=$(ssh -o ControlPath="$SSH_CONTROL_STANDBY" "${STANDBY_REMOTE}" "cat \$HOME/.local/state/openclaw-watchdog/state 2>/dev/null || echo STANDBY")
      echo "  Standby watchdog state: $standby_state"
      deploy_to_host "standby" "$SSH_CONTROL_STANDBY" "$STANDBY_REMOTE" "standby" "$standby_state" || DEPLOY_FAIL=true
      echo ""
    fi
  fi
fi

# Output restart state for GitHub Actions health check (read from temp file shared with subshells)
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "restarted=$(cat "$RESTART_FLAG_FILE")" >> "$GITHUB_OUTPUT"
fi
rm -f "$RESTART_FLAG_FILE"

echo "=== Deploy complete ==="

if $DEPLOY_FAIL; then
  exit 1
fi
