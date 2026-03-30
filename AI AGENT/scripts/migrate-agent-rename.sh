#!/bin/bash
# migrate-agent-rename.sh — Run ONCE on remote server
# Renames agent dirs and workspaces for cams-cryp-pre / cams-cryp-ol
set -euo pipefail

BASE="/home/hqj/.openclaw"

echo "=== OpenClaw Agent Rename Migration ==="
echo "This script renames:"
echo "  cams-query     → cams-cryp-pre"
echo "  cams-query-ol  → cams-cryp-ol"
echo ""

# Pre-check: gateway should be stopped
if pgrep -f "openclaw" > /dev/null 2>&1; then
  echo "WARNING: OpenClaw process detected. Stop gateway first:"
  echo "  openclaw gateway stop"
  read -p "Continue anyway? (y/N) " confirm
  [ "$confirm" = "y" ] || exit 1
fi

# 1. Rename workspace directories
echo "[1/4] Renaming workspaces..."
if [ -d "$BASE/workspace-cams" ]; then
  mv "$BASE/workspace-cams" "$BASE/workspace-cams-cryp-pre"
  echo "  workspace-cams → workspace-cams-cryp-pre"
else
  echo "  workspace-cams not found, skipping"
fi
if [ -d "$BASE/workspace-cams-ol" ]; then
  mv "$BASE/workspace-cams-ol" "$BASE/workspace-cams-cryp-ol"
  echo "  workspace-cams-ol → workspace-cams-cryp-ol"
else
  echo "  workspace-cams-ol not found, skipping"
fi

# 2. Create new agent directories
echo "[2/4] Creating new agent directories..."
mkdir -p "$BASE/agents/cams-cryp-pre/agent"
mkdir -p "$BASE/agents/cams-cryp-pre/sessions"
mkdir -p "$BASE/agents/cams-cryp-ol/agent"
mkdir -p "$BASE/agents/cams-cryp-ol/sessions"

# 3. Copy agent state and sessions from old to new
echo "[3/4] Migrating agent state and sessions..."
for pair in "cams-query:cams-cryp-pre" "cams-query-ol:cams-cryp-ol"; do
  old="${pair%%:*}"
  new="${pair##*:}"

  # Copy agent state (auth-profiles, etc.)
  if [ -d "$BASE/agents/$old/agent" ]; then
    cp -a "$BASE/agents/$old/agent/." "$BASE/agents/$new/agent/"
    echo "  $old/agent → $new/agent"
  else
    echo "  $old/agent not found, skipping"
  fi

  # Copy session history (JSONL transcripts)
  if [ -d "$BASE/agents/$old/sessions" ]; then
    cp -a "$BASE/agents/$old/sessions/." "$BASE/agents/$new/sessions/"
    echo "  $old/sessions → $new/sessions"
  else
    echo "  $old/sessions not found, skipping"
  fi
done

# 4. Backup old global skills directory
echo "[4/4] Backing up old global skills..."
if [ -d "$BASE/skills" ]; then
  mv "$BASE/skills" "$BASE/skills.bak.$(date +%Y%m%d)"
  echo "  skills/ → skills.bak.$(date +%Y%m%d) (backup)"
else
  echo "  No global skills/ found, skipping"
fi

echo ""
echo "=== Migration complete ==="
echo ""
echo "Old directories preserved (safe to delete after verification):"
echo "  $BASE/agents/cams-query/"
echo "  $BASE/agents/cams-query-ol/"
echo "  $BASE/skills.bak.*"
echo ""
echo "Next steps:"
echo "  1. Deploy new config:  ./scripts/deploy.sh --all"
echo "  2. Verify gateway:     openclaw gateway status"
echo "  3. Test agent in Telegram"
echo "  4. After verified, remove old dirs manually"
