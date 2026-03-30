# Deploy Optimization Design Spec

**Date**: 2026-03-22
**Scope**: `scripts/deploy.sh` + `.github/workflows/deploy.yml`
**Goal**: Reduce deployment time by parallelizing, eliminating unnecessary restarts, consolidating SSH round-trips, and improving health check reliability.

## 1. Parallel Deployment to Both Servers

**Problem**: Primary and standby are deployed serially in `deploy.sh:386-401`, doubling total time when `--target both`.

**Solution**:
- When `DEPLOY_TARGET=both`, run `deploy_to_host` for each server as background jobs (`&`)
- Redirect each job's stdout/stderr to separate temp log files to avoid interleaved output
- `wait` on each PID and collect exit codes; fail if either fails
- After both complete, cat logs in order (primary first, then standby) for readable output
- Single-server deploys (`--target primary` or `--target standby`) remain unchanged

**Safety**:
- SSH multiplexing already uses separate control paths (`$SSH_CONTROL_PRIMARY` / `$SSH_CONTROL_STANDBY`), so parallel SSH sessions don't conflict.
- **Race condition fix**: `deploy.sh:210` hardcodes `/tmp/github-app.pem`. When both jobs run in parallel, they race on this path. Fix by using `mktemp` (e.g., `/tmp/github-app-$$.pem` or `mktemp`) for each invocation.
- **`set -e` interaction**: Background jobs are not affected by `set -e`. Must capture exit codes defensively (`wait $pid || code=$?`) and wait for BOTH jobs before evaluating, to avoid orphaning the second job if the first fails.

**Files changed**: `scripts/deploy.sh` (execution block at bottom, ~lines 386-401; hardcoded temp path at ~line 210)

## 2. Conditional Gateway Restart

**Problem**: `--all` unconditionally sets `RESTART=true` (line 92), causing a gateway restart + 20s wait even for changes that don't require it.

**Solution**:
- Introduce `NEEDS_RESTART=false` variable
- Auto-set `NEEDS_RESTART=true` when any of: `DEPLOY_CONFIG`, `DEPLOY_SKILLS` is true
  - **config**: gateway reads openclaw.json on startup
  - **skills**: gateway loads skill snapshots on startup
- `DEPLOY_SOUL` does NOT trigger restart. The existing session reset logic (`deploy.sh:334-346`) already clears stale sessions by writing `{}` to `sessions.json`, which is sufficient for SOUL.md adoption on next session creation. Gateway process restart is unnecessary.
- `DEPLOY_CRON` and `DEPLOY_SECRETS` do NOT trigger restart (cron is managed externally, secrets are read on-demand)
- Explicit `--restart` flag always forces restart (manual override preserved)
- `--all` sets all deploy flags + `NEEDS_RESTART=true` (because it includes config/skills), but does NOT set `RESTART=true` directly
- Final restart decision: `if $RESTART || $NEEDS_RESTART`

**Restart decision matrix**:

| Deploy target | Needs restart? |
|---------------|---------------|
| `--config`    | Yes           |
| `--skills`    | Yes           |
| `--soul`      | No (session reset handles it) |
| `--cron`      | No            |
| `--secrets`   | No            |
| `--all`       | Yes (contains config+skills) |
| `--restart`   | Yes (explicit override) |

**Files changed**: `scripts/deploy.sh` (argument parsing + deploy_to_host restart logic)

## 3. SOUL.md Consolidation via rsync

**Problem**: `deploy.sh:260-263` executes 6 individual `scp` commands for SOUL.md files, one per workspace. Each is a separate SSH round-trip.

**Solution**:
- Stage all SOUL.md files into a temp directory mirroring the remote layout:
  ```
  $SOUL_STAGE/workspace-cams-cryp-pre/SOUL.md
  $SOUL_STAGE/workspace-cams-cryp-ol/SOUL.md
  ...
  ```
- Single `rsync -avz --include='*/' --include='SOUL.md' --exclude='*'` to sync all at once
- rsync provides automatic checksum-based incremental transfer
- Clean up temp directory after sync
- `onepay/docs` rsync remains unchanged

**Files changed**: `scripts/deploy.sh` (DEPLOY_SOUL block, ~lines 255-270)

## 4. Health Check Polling (replace fixed sleep)

**Problem**: `deploy.yml:126-127` uses `sleep 20` before a single health check attempt. If gateway starts faster, time is wasted. If it needs longer, the single check fails with no retry.

**Solution**:
- Replace `sleep 20` + single check with a polling loop inside `check_health()`
- Poll every 5 seconds, up to 30 seconds max (6 attempts)
- Return `GATEWAY_ACTIVE` as soon as detected
- After 30 seconds, return last observed status (INACTIVE / SSH_FAILED)
- Remove the `sleep 20` from deploy.yml

**Restart-state passing**: `deploy.sh` must signal whether a restart occurred so the health check step knows whether to poll or just do an immediate check.
- `deploy.sh` writes `restarted=true|false` to `$GITHUB_OUTPUT` (the deploy step already has `id: deploy`)
- Health check step reads `${{ steps.deploy.outputs.restarted }}`
- If `restarted=false`: skip polling, do single immediate health check
- If `restarted=true`: use polling loop

**Implementation**: `deploy.sh` accepts a new env var `GITHUB_OUTPUT` (already available in GitHub Actions). At the end of execution, if any host was restarted, write `restarted=true`. This keeps the interface clean — deploy.sh just writes one output.

**Polling parameters**:
- `interval=5` seconds
- `max_wait=30` seconds (20s typical + 10s buffer)
- `attempts=6` maximum

**Trade-off note**: Polling adds multiple SSH connections in the normal case (4 checks vs. 1). This is acceptable since SSH multiplexing reuses the existing connection and the overhead is negligible compared to the 20s wait.

**Files changed**: `.github/workflows/deploy.yml` (health check step, ~lines 112-163), `scripts/deploy.sh` (output `restarted` flag)

## Summary of Expected Improvements

| Scenario | Before | After | Savings |
|----------|--------|-------|---------|
| `--all --target both` | ~2T (serial) | ~T (parallel) | ~50% |
| `--cron` only | Deploy + restart + 20s wait | Deploy only | ~25s |
| `--secrets` only | Deploy + restart + 20s wait | Deploy only | ~25s |
| Health check (normal) | Fixed 20s | ~20s (4 polls) | ~0s |
| Health check (fast restart) | Fixed 20s | ~5-15s | 5-15s |
| Health check (slow restart) | Fail after 20s | Retry up to 30s | More reliable |
| SOUL.md deploy | 6 scp calls | 1 rsync call | 5 fewer SSH round-trips |
