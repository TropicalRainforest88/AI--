# Deploy Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce deployment time by parallelizing primary/standby, adding conditional restart, consolidating SOUL.md transfers, and replacing fixed health check sleep with polling.

**Architecture:** All changes are in two files: `scripts/deploy.sh` (parallel deploy, conditional restart, rsync consolidation) and `.github/workflows/deploy.yml` (health check polling). `deploy.sh` outputs a `restarted` flag via `$GITHUB_OUTPUT` for the workflow to read.

**Tech Stack:** Bash, rsync, SSH multiplexing, GitHub Actions

**Spec:** `docs/superpowers/specs/2026-03-22-deploy-optimization-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `scripts/deploy.sh` | Modify | Parallel deploy, conditional restart, SOUL.md rsync, temp file race fix, restarted output |
| `.github/workflows/deploy.yml` | Modify | Health check polling, read restarted flag |

---

### Task 1: Fix hardcoded temp path race condition

**Files:**
- Modify: `scripts/deploy.sh:210-213`

This must be done first as it's a prerequisite for safe parallel execution.

- [ ] **Step 1: Replace hardcoded `/tmp/github-app.pem` with mktemp**

In `scripts/deploy.sh`, find lines 208-213 inside `deploy_to_host()`:

```bash
# BEFORE (line 210-213):
printf '%s' "${REVIEWER_APP_PRIVATE_KEY_BASE64}" | base64 -d > /tmp/github-app.pem
$ssh_cmd "${remote}" "mkdir -p ${BASE}/secrets"
$scp_cmd /tmp/github-app.pem "${remote}:${BASE}/secrets/github-app.pem"
rm -f /tmp/github-app.pem

# AFTER:
TEMP_APP_KEY=$(mktemp)
printf '%s' "${REVIEWER_APP_PRIVATE_KEY_BASE64}" | base64 -d > "$TEMP_APP_KEY"
$ssh_cmd "${remote}" "mkdir -p ${BASE}/secrets"
$scp_cmd "$TEMP_APP_KEY" "${remote}:${BASE}/secrets/github-app.pem"
rm -f "$TEMP_APP_KEY"
```

- [ ] **Step 2: Verify syntax**

Run: `bash -n scripts/deploy.sh`
Expected: No output (no syntax errors)

- [ ] **Step 3: Commit**

```bash
git add scripts/deploy.sh
git commit -m "fix: replace hardcoded /tmp/github-app.pem with mktemp for parallel safety"
```

---

### Task 2: Add conditional restart logic

**Files:**
- Modify: `scripts/deploy.sh:36-93` (variables and argument parsing)
- Modify: `scripts/deploy.sh:371-382` (restart block in deploy_to_host)

- [ ] **Step 1: Add NEEDS_RESTART variable and update --all block**

In `scripts/deploy.sh`, add `NEEDS_RESTART=false` after `RESTART=false` (line 42), then replace the `--all` block (lines 86-93):

```bash
# Line 42, add after RESTART=false:
NEEDS_RESTART=false

# Replace lines 86-93:
# BEFORE:
if $DEPLOY_ALL; then
  DEPLOY_CONFIG=true
  DEPLOY_SKILLS=true
  DEPLOY_SOUL=true
  DEPLOY_CRON=true
  DEPLOY_SECRETS=true
  RESTART=true
fi

# AFTER:
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
```

- [ ] **Step 2: Update restart block in deploy_to_host**

Replace lines 371-382:

```bash
# BEFORE:
  if $RESTART; then

# AFTER:
  if $RESTART || $NEEDS_RESTART; then
```

- [ ] **Step 3: Verify syntax**

Run: `bash -n scripts/deploy.sh`
Expected: No output

- [ ] **Step 4: Commit**

```bash
git add scripts/deploy.sh
git commit -m "feat: conditional restart - only restart gateway when config/skills change"
```

---

### Task 3: Add restarted output flag for GitHub Actions

**Files:**
- Modify: `scripts/deploy.sh` (end of deploy_to_host + end of script)

- [ ] **Step 1: Track whether any host was actually restarted**

Add a temp file variable after `NEEDS_RESTART=false`:

```bash
RESTART_FLAG_FILE=$(mktemp)
echo "false" > "$RESTART_FLAG_FILE"
```

Note: We use a temp file instead of a shell variable because `deploy_to_host` may run in background subshells (Task 5 parallel deploy). Subshell variable changes don't propagate to the parent. A temp file is shared across all processes.

Inside `deploy_to_host()`, in the restart block, after the restart command succeeds, write to the flag file:

```bash
  if $RESTART || $NEEDS_RESTART; then
    if [ "$role" = "standby" ] && [ "$standby_state" = "STANDBY" ]; then
      echo ""
      echo "  Skipping gateway restart (standby in STANDBY state)"
    else
      echo ""
      echo "  Restarting OpenClaw gateway..."
      $ssh_cmd "${remote}" "systemctl --user restart openclaw-gateway.service 2>/dev/null || (cd ${BASE} && openclaw gateway restart 2>/dev/null) || echo 'Please restart gateway manually'"
      echo "    -> Gateway restart requested"
      echo "true" > "$RESTART_FLAG_FILE"
    fi
  fi
```

The `$GITHUB_OUTPUT` write happens in Task 5 (execution block) after all deploys complete, reading from the flag file.

- [ ] **Step 2: Verify syntax**

Run: `bash -n scripts/deploy.sh`
Expected: No output

- [ ] **Step 3: Commit**

```bash
git add scripts/deploy.sh
git commit -m "feat: output restarted flag to GITHUB_OUTPUT for health check"
```

---

### Task 4: Consolidate SOUL.md scp into single rsync

**Files:**
- Modify: `scripts/deploy.sh:255-269` (DEPLOY_SOUL block in deploy_to_host)

- [ ] **Step 1: Replace 6 scp calls with staged rsync**

Replace the SOUL.md deployment block inside `deploy_to_host()`:

```bash
# BEFORE (lines 255-269):
  if $DEPLOY_SOUL; then
    echo "  [3/5] Deploying SOUL.md files..."

    $ssh_cmd "${remote}" "mkdir -p ${BASE}/workspace-cams-cryp-pre ${BASE}/workspace-cams-cryp-ol ${BASE}/workspace-onepay ${BASE}/workspace-gb-ol ${BASE}/workspace-openclaw-coderevie-ol ${BASE}/workspace-settlement ${BASE}/workspace-onepay/docs"

    for ws in cams-cryp-pre cams-cryp-ol onepay gb-ol openclaw-coderevie-ol settlement; do
      $scp_cmd "$PROJECT_DIR/workspaces/${ws}/SOUL.md" \
        "${remote}:${BASE}/workspace-${ws}/SOUL.md"
    done

    rsync -avz \
      -e "$rsync_ssh" \
      "$PROJECT_DIR/workspaces/onepay/docs/" \
      "${remote}:${BASE}/workspace-onepay/docs/"
    echo "    -> SOUL.md files deployed"
  fi

# AFTER:
  if $DEPLOY_SOUL; then
    echo "  [3/5] Deploying SOUL.md files..."

    $ssh_cmd "${remote}" "mkdir -p ${BASE}/workspace-cams-cryp-pre ${BASE}/workspace-cams-cryp-ol ${BASE}/workspace-onepay ${BASE}/workspace-gb-ol ${BASE}/workspace-openclaw-coderevie-ol ${BASE}/workspace-settlement ${BASE}/workspace-onepay/docs"

    # Stage SOUL.md files into temp directory for single rsync
    SOUL_STAGE=$(mktemp -d)
    for ws in cams-cryp-pre cams-cryp-ol onepay gb-ol openclaw-coderevie-ol settlement; do
      mkdir -p "${SOUL_STAGE}/workspace-${ws}"
      cp "$PROJECT_DIR/workspaces/${ws}/SOUL.md" "${SOUL_STAGE}/workspace-${ws}/SOUL.md"
    done

    rsync -avz \
      -e "$rsync_ssh" \
      "${SOUL_STAGE}/" "${remote}:${BASE}/"
    rm -rf "$SOUL_STAGE"

    # onepay/docs sync (unchanged)
    rsync -avz \
      -e "$rsync_ssh" \
      "$PROJECT_DIR/workspaces/onepay/docs/" \
      "${remote}:${BASE}/workspace-onepay/docs/"
    echo "    -> SOUL.md files deployed"
  fi
```

- [ ] **Step 2: Verify syntax**

Run: `bash -n scripts/deploy.sh`
Expected: No output

- [ ] **Step 3: Commit**

```bash
git add scripts/deploy.sh
git commit -m "perf: consolidate 6 SOUL.md scp calls into single rsync"
```

---

### Task 5: Parallel deployment execution

**Files:**
- Modify: `scripts/deploy.sh:385-404` (execution block at bottom)

- [ ] **Step 1: Replace serial execution with parallel when both targets**

Replace the execution block at the bottom of `scripts/deploy.sh`:

```bash
# BEFORE (lines 385-404):
# --- Execute deployment ---
if [ "$DEPLOY_TARGET" = "primary" ] || [ "$DEPLOY_TARGET" = "both" ]; then
  echo "=== Deploying to PRIMARY ($REMOTE_HOST) ==="
  deploy_to_host "primary" "$SSH_CONTROL_PRIMARY" "$PRIMARY_REMOTE" "primary" ""
  echo ""
fi

if [ "$DEPLOY_TARGET" = "standby" ] || [ "$DEPLOY_TARGET" = "both" ]; then
  if [ -z "${STANDBY_HOST:-}" ]; then
    echo "WARNING: STANDBY_HOST not set, skipping standby deployment"
  else
    echo "=== Deploying to STANDBY ($STANDBY_HOST) ==="
    standby_state=$(ssh -o ControlPath="$SSH_CONTROL_STANDBY" "${STANDBY_REMOTE}" "cat \$HOME/.local/state/openclaw-watchdog/state 2>/dev/null || echo STANDBY")
    echo "  Standby watchdog state: $standby_state"
    deploy_to_host "standby" "$SSH_CONTROL_STANDBY" "$STANDBY_REMOTE" "standby" "$standby_state"
    echo ""
  fi
fi

echo "=== Deploy complete ==="

# AFTER:
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
```

- [ ] **Step 2: Verify syntax**

Run: `bash -n scripts/deploy.sh`
Expected: No output

- [ ] **Step 3: Commit**

```bash
git add scripts/deploy.sh
git commit -m "perf: parallel deployment to primary and standby servers"
```

---

### Task 6: Health check polling in deploy.yml

**Files:**
- Modify: `.github/workflows/deploy.yml:112-163` (Health Check step)

- [ ] **Step 1: Replace fixed sleep with polling loop**

Replace the entire Health Check step:

```yaml
      - name: Health Check
        id: healthcheck
        if: always()
        env:
          SSHPASS: ${{ secrets.REMOTE_PASSWORD }}
          SSHPASS_STANDBY: ${{ secrets.STANDBY_PASSWORD }}
        run: |
          SERVER="${{ github.event.inputs.server || 'both' }}"
          REMOTE_USER="${{ secrets.REMOTE_USER }}"
          REMOTE_HOST="${{ secrets.REMOTE_HOST }}"
          STANDBY_USER="${{ secrets.STANDBY_USER }}"
          STANDBY_HOST="${{ secrets.STANDBY_HOST }}"
          RESTARTED="${{ steps.deploy.outputs.restarted }}"

          PRIMARY_OK="skip"
          STANDBY_OK="skip"

          check_health() {
            local label="$1" user="$2" host="$3" pass="$4"
            echo "Checking ${label} (${host})..." >&2
            local result
            result=$(SSHPASS="$pass" sshpass -e ssh -o StrictHostKeyChecking=no "${user}@${host}" \
              'if systemctl --user is-active openclaw-gateway.service >/dev/null 2>&1; then echo "GATEWAY_ACTIVE"; elif pgrep -f "openclaw.*gateway" >/dev/null 2>&1; then echo "GATEWAY_ACTIVE"; else echo "GATEWAY_INACTIVE"; fi' 2>/dev/null) || result="SSH_FAILED"
            echo "  -> ${result}" >&2
            echo "$result"
          }

          check_health_poll() {
            local label="$1" user="$2" host="$3" pass="$4"
            local max_wait=30
            local interval=5
            local elapsed=0
            local result=""

            echo "Polling ${label} (${host}) for gateway health (max ${max_wait}s)..." >&2
            while [ $elapsed -lt $max_wait ]; do
              result=$(SSHPASS="$pass" sshpass -e ssh -o StrictHostKeyChecking=no "${user}@${host}" \
                'if systemctl --user is-active openclaw-gateway.service >/dev/null 2>&1; then echo "GATEWAY_ACTIVE"; elif pgrep -f "openclaw.*gateway" >/dev/null 2>&1; then echo "GATEWAY_ACTIVE"; else echo "GATEWAY_INACTIVE"; fi' 2>/dev/null) || result="SSH_FAILED"
              echo "  [${elapsed}s] ${result}" >&2
              if [ "$result" = "GATEWAY_ACTIVE" ]; then
                echo "$result"
                return 0
              fi
              sleep $interval
              elapsed=$((elapsed + interval))
            done

            echo "  Timeout after ${max_wait}s" >&2
            echo "$result"
          }

          if [ "$SERVER" = "primary" ] || [ "$SERVER" = "both" ]; then
            if [ "$RESTARTED" = "true" ]; then
              PRIMARY_OK=$(check_health_poll "primary" "$REMOTE_USER" "$REMOTE_HOST" "$SSHPASS")
            else
              PRIMARY_OK=$(check_health "primary" "$REMOTE_USER" "$REMOTE_HOST" "$SSHPASS")
            fi
          fi

          if [ "$SERVER" = "standby" ] || [ "$SERVER" = "both" ]; then
            if [ -n "$STANDBY_HOST" ]; then
              if [ "$RESTARTED" = "true" ]; then
                STANDBY_OK=$(check_health_poll "standby" "$STANDBY_USER" "$STANDBY_HOST" "${SSHPASS_STANDBY:-}")
              else
                STANDBY_OK=$(check_health "standby" "$STANDBY_USER" "$STANDBY_HOST" "${SSHPASS_STANDBY:-}")
              fi
            fi
          fi

          echo "primary_status=${PRIMARY_OK}" >> "$GITHUB_OUTPUT"
          echo "standby_status=${STANDBY_OK}" >> "$GITHUB_OUTPUT"

          # Fail if any checked server is unhealthy
          if echo "$PRIMARY_OK" | grep -q "GATEWAY_ACTIVE\|skip"; then PRIMARY_PASS=true; else PRIMARY_PASS=false; fi
          if echo "$STANDBY_OK" | grep -q "GATEWAY_ACTIVE\|skip"; then STANDBY_PASS=true; else STANDBY_PASS=false; fi

          if $PRIMARY_PASS && $STANDBY_PASS; then
            echo "all_healthy=true" >> "$GITHUB_OUTPUT"
          else
            echo "all_healthy=false" >> "$GITHUB_OUTPUT"
          fi
```

- [ ] **Step 2: Validate YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy.yml'))"`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "perf: replace fixed sleep 20 health check with adaptive polling"
```

---

### Task 7: Final verification

- [ ] **Step 1: Verify deploy.sh syntax**

Run: `bash -n scripts/deploy.sh`
Expected: No output

- [ ] **Step 2: Verify deploy.yml YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy.yml'))"`
Expected: No errors

- [ ] **Step 3: Review complete diff**

Run: `git diff main -- scripts/deploy.sh .github/workflows/deploy.yml`
Verify: All 4 optimizations are present, no unintended changes

- [ ] **Step 4: Verify no debug artifacts or hardcoded paths remain**

Run: `grep -n '/tmp/github-app' scripts/deploy.sh`
Expected: No matches (all replaced with mktemp)
