#!/bin/bash
# daily-digest.sh — Thin wrapper: source secrets, set env, invoke Python collector.
# Deployed to ~/.openclaw/scripts/daily-digest.sh on the remote server.
set -euo pipefail

BASE="${OPENCLAW_BASE:-$HOME/.openclaw}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Source secrets
if [ -f "${BASE}/secrets/openai-admin.sh" ]; then
  source "${BASE}/secrets/openai-admin.sh"
fi

# Calculate report date (yesterday in UTC)
# GNU date and BSD date have different syntax
export REPORT_DATE="${REPORT_DATE:-$(TZ=UTC date -d 'yesterday' '+%Y-%m-%d' 2>/dev/null || TZ=UTC date -v-1d '+%Y-%m-%d')}"
export OPENCLAW_BASE="$BASE"

# Run Python collector
exec python3 "${SCRIPT_DIR}/daily-digest-collect.py"
