#!/bin/bash
set -euo pipefail

# ==============================================================================
# OpenClaw HA Watchdog — State Machine Failover Monitor
#
# Invoked once per execution by a systemd timer (every 30 seconds).
# Monitors primary server gateway health and performs automatic failover.
# ==============================================================================

# --- Constants ----------------------------------------------------------------
FAIL_THRESHOLD=10           # 10 checks × 30s = 5 minutes to failover
RECOVER_THRESHOLD=3         # 3 checks × 30s = 1.5 minutes to yield
COOLDOWN_SECONDS=300        # 5 minute cooldown after failback
FLAP_THRESHOLD=3            # max flaps before ALERT
FLAP_DECAY_SECONDS=3600    # 1 hour stable = reset flap count
HEALTH_TIMEOUT=5            # curl timeout in seconds
STATE_DIR="$HOME/.local/state/openclaw-watchdog"
OPENCLAW_BASE="$HOME/.openclaw"

# --- Load environment ---------------------------------------------------------
ENV_FILE="$OPENCLAW_BASE/watchdog/watchdog.env"
if [[ -f "$ENV_FILE" ]]; then
    # shellcheck source=/dev/null
    source "$ENV_FILE"
else
    echo "$(date -Iseconds) [ERROR] watchdog.env not found at $ENV_FILE"
    exit 1
fi

# --- Helper functions ---------------------------------------------------------

ensure_state_dir() {
    mkdir -p "$STATE_DIR"
}

read_state() {
    local file="$STATE_DIR/state"
    if [[ -f "$file" ]]; then
        cat "$file"
    else
        echo "STANDBY"
    fi
}

write_state() {
    echo "$1" > "$STATE_DIR/state"
}

read_count() {
    local file="$STATE_DIR/$1"
    if [[ -f "$file" ]]; then
        cat "$file"
    else
        echo "0"
    fi
}

write_count() {
    echo "$2" > "$STATE_DIR/$1"
}

read_timestamp() {
    local file="$STATE_DIR/$1"
    if [[ -f "$file" ]]; then
        cat "$file"
    else
        echo ""
    fi
}

write_timestamp() {
    echo "$2" > "$STATE_DIR/$1"
}

log_msg() {
    echo "$(date -Iseconds) [watchdog] $1"
}

send_telegram() {
    local msg="$1"
    curl -sf --max-time 10 \
        -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
        -d chat_id="${ALERT_CHAT_ID}" \
        -d text="${msg}" \
        -d parse_mode="HTML" \
        > /dev/null 2>&1 || true
}

health_check() {
    curl -sf --max-time "$HEALTH_TIMEOUT" \
        "http://${PRIMARY_HOST}:${PRIMARY_PORT}/health" \
        > /dev/null 2>&1
}

ping_check() {
    ping -c1 -W3 "$PRIMARY_HOST" > /dev/null 2>&1
}

ssh_port_check() {
    nc -z -w3 "$PRIMARY_HOST" 22 > /dev/null 2>&1
}

remote_stop_gateway() {
    ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no \
        "${PRIMARY_SSH_USER}@${PRIMARY_HOST}" \
        "systemctl --user stop openclaw-gateway.service" \
        2>/dev/null || true
}

enable_local_cron() {
    local jobs_file="$OPENCLAW_BASE/cron/jobs.json"
    if [[ -f "$jobs_file" ]]; then
        sed -i 's/"enabled": false/"enabled": true/g' "$jobs_file"
    fi
}

disable_local_cron() {
    local jobs_file="$OPENCLAW_BASE/cron/jobs.json"
    if [[ -f "$jobs_file" ]]; then
        sed -i 's/"enabled": true/"enabled": false/g' "$jobs_file"
    fi
}

start_services() {
    log_msg "Starting local services..."
    systemctl --user start openclaw-gateway.service
    enable_local_cron
    log_msg "Local services started."
}

stop_services() {
    log_msg "Stopping local services..."
    systemctl --user stop openclaw-gateway.service
    disable_local_cron
    log_msg "Local services stopped."
}

check_flap_limit() {
    local flap_count
    flap_count=$(read_count "flap_count")
    if (( flap_count >= FLAP_THRESHOLD )); then
        write_state "ALERT"
        send_telegram "🚨 主機反覆不穩（已切換 ${flap_count} 次），暫停自動切換，請人工介入"
        log_msg "ALERT: flap_count=${flap_count} >= threshold=${FLAP_THRESHOLD}, entering ALERT state"
        return 0  # entered ALERT
    fi
    return 1  # did not enter ALERT
}

# --- Reset handler ------------------------------------------------------------

if [[ "${1:-}" == "--reset" ]]; then
    ensure_state_dir
    write_state "STANDBY"
    write_count "fail_count" 0
    write_count "recover_count" 0
    write_count "flap_count" 0
    rm -f "$STATE_DIR/cooldown_start" "$STATE_DIR/last_flap_time"
    send_telegram "🔧 Watchdog 已手動重置為 STANDBY"
    log_msg "手動重置完成"
    exit 0
fi

# --- Main state machine -------------------------------------------------------

main() {
    ensure_state_dir

    # Write heartbeat
    date +%s > "$STATE_DIR/heartbeat"

    local current_state
    current_state=$(read_state)
    local now
    now=$(date +%s)

    log_msg "State: ${current_state}"

    case "$current_state" in

        STANDBY)
            if health_check; then
                write_count "fail_count" 0

                # Check flap decay
                local last_flap_time
                last_flap_time=$(read_timestamp "last_flap_time")
                if [[ -n "$last_flap_time" ]]; then
                    local elapsed=$(( now - last_flap_time ))
                    if (( elapsed > FLAP_DECAY_SECONDS )); then
                        write_count "flap_count" 0
                        rm -f "$STATE_DIR/last_flap_time"
                        log_msg "Flap count decayed to 0 after ${elapsed}s stable"
                    fi
                fi
            else
                local fail_count
                fail_count=$(read_count "fail_count")
                fail_count=$(( fail_count + 1 ))
                write_count "fail_count" "$fail_count"
                log_msg "Health check failed (fail_count=${fail_count}/${FAIL_THRESHOLD})"

                if (( fail_count >= FAIL_THRESHOLD )); then
                    log_msg "Fail threshold reached, running secondary checks..."

                    # Secondary confirmation
                    local ping_ok=false ssh_ok=false
                    ping_check && ping_ok=true
                    ssh_port_check && ssh_ok=true

                    log_msg "Secondary checks: ping=${ping_ok}, ssh=${ssh_ok}"

                    # If SSH reachable but gateway down, try to stop remote gateway
                    if [[ "$ssh_ok" == "true" ]]; then
                        log_msg "SSH reachable, attempting remote gateway stop..."
                        remote_stop_gateway
                    fi

                    # Failover: start local services
                    start_services

                    send_telegram "⚠️ 主機無回應（連續 5 分鐘），備機已接手服務"
                    write_state "ACTIVE"
                    write_count "fail_count" 0
                    write_count "recover_count" 0
                    log_msg "Failover complete, now ACTIVE"
                fi
            fi
            ;;

        ACTIVE)
            if health_check; then
                local recover_count
                recover_count=$(read_count "recover_count")
                recover_count=$(( recover_count + 1 ))
                write_count "recover_count" "$recover_count"
                log_msg "Primary healthy (recover_count=${recover_count}/${RECOVER_THRESHOLD})"

                if (( recover_count >= RECOVER_THRESHOLD )); then
                    log_msg "Recover threshold reached, yielding to primary..."

                    # Stop local services
                    stop_services

                    # Wait for primary to stabilize
                    sleep 10

                    # Post-failback verification
                    if health_check; then
                        log_msg "Post-failback verification passed"
                        send_telegram "✅ 主機已恢復，備機已讓位"

                        # Record cooldown and flap
                        write_timestamp "cooldown_start" "$now"
                        local flap_count
                        flap_count=$(read_count "flap_count")
                        flap_count=$(( flap_count + 1 ))
                        write_count "flap_count" "$flap_count"
                        write_timestamp "last_flap_time" "$now"

                        # Check flap limit
                        if ! check_flap_limit; then
                            write_state "COOLDOWN"
                            log_msg "Entering COOLDOWN (flap_count=${flap_count})"
                        fi
                    else
                        log_msg "Post-failback verification failed, resuming ACTIVE"
                        start_services
                        send_telegram "⚠️ 讓位驗證失敗，備機重新接手"
                        # Stay ACTIVE
                    fi
                fi
            else
                write_count "recover_count" 0
                log_msg "Primary still unhealthy, staying ACTIVE"
            fi
            ;;

        COOLDOWN)
            local cooldown_start
            cooldown_start=$(read_timestamp "cooldown_start")
            if [[ -z "$cooldown_start" ]]; then
                # Shouldn't happen, but recover gracefully
                log_msg "Missing cooldown_start, resetting to STANDBY"
                write_state "STANDBY"
                return
            fi

            local elapsed=$(( now - cooldown_start ))
            local remaining=$(( COOLDOWN_SECONDS - elapsed ))

            if (( elapsed < COOLDOWN_SECONDS )); then
                log_msg "冷卻期中，剩餘 ${remaining} 秒"
            else
                log_msg "Cooldown expired, checking primary health..."

                if health_check; then
                    write_state "STANDBY"
                    log_msg "冷卻期結束，回到待命"
                else
                    log_msg "Primary still unhealthy after cooldown, re-activating..."
                    start_services

                    local flap_count
                    flap_count=$(read_count "flap_count")
                    flap_count=$(( flap_count + 1 ))
                    write_count "flap_count" "$flap_count"
                    write_timestamp "last_flap_time" "$now"

                    send_telegram "⚠️ 冷卻期結束但主機仍無回應，備機重新接手"

                    if ! check_flap_limit; then
                        write_state "ACTIVE"
                        log_msg "Re-entered ACTIVE (flap_count=${flap_count})"
                    fi
                fi
            fi
            ;;

        ALERT)
            log_msg "ALERT 狀態，等待人工介入。使用 watchdog.sh --reset 重置"
            ;;

        *)
            log_msg "Unknown state: ${current_state}, resetting to STANDBY"
            write_state "STANDBY"
            ;;
    esac
}

main
