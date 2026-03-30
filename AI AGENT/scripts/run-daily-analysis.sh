#!/bin/bash
# run-daily-analysis.sh — macOS launchd 觸發的每日營運分析啟動腳本
# 由 launchd plist (com.openclaw.daily-analysis) 每天 09:00 UTC+8 呼叫
# 透過 Claude Code CLI 執行 /daily-analysis skill
set -uo pipefail

# ---------------------------------------------------------------------------
# 路徑與環境（可透過環境變數覆寫）
# ---------------------------------------------------------------------------
WORK_DIR="${WORK_DIR:-/Users/curtis/Dev/openclaw_op}"
CLAUDE_BIN="${CLAUDE_BIN:-/Users/curtis/.local/bin/claude}"
LOCAL_ENV="${LOCAL_ENV:-$HOME/.openclaw-local-env}"
MCP_CONFIG="${MCP_CONFIG:-$WORK_DIR/.mcp.json}"
LOG_TAG="[daily-analysis]"

# 確保 PATH 包含常用工具
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# ---------------------------------------------------------------------------
# 日誌輔助
# ---------------------------------------------------------------------------
log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') $LOG_TAG $*"
}

log "===== 開始每日營運分析 ====="

# ---------------------------------------------------------------------------
# 載入本機環境變數（TELEGRAM_BOT_TOKEN, OPENAI_ADMIN_API_KEY 等）
# ---------------------------------------------------------------------------
if [[ -f "$LOCAL_ENV" ]]; then
  log "載入環境變數：$LOCAL_ENV"
  # shellcheck disable=SC1090
  source "$LOCAL_ENV"
else
  log "錯誤：找不到 $LOCAL_ENV，中止執行"
  exit 1
fi

# ---------------------------------------------------------------------------
# 計算報告日期（UTC 昨天）
# ---------------------------------------------------------------------------
export REPORT_DATE="${REPORT_DATE:-$(TZ=UTC date -v-1d '+%Y-%m-%d')}"
log "報告日期：$REPORT_DATE"

# ---------------------------------------------------------------------------
# 檢查 Claude CLI 存在
# ---------------------------------------------------------------------------
if [[ ! -x "$CLAUDE_BIN" ]]; then
  log "錯誤：找不到 Claude CLI ($CLAUDE_BIN)，中止執行"
  exit 1
fi

log "Claude CLI 版本：$("$CLAUDE_BIN" --version 2>/dev/null || echo '未知')"

# ---------------------------------------------------------------------------
# 執行 Claude Code CLI — 呼叫 /daily-analysis skill
# ---------------------------------------------------------------------------
log "啟動 Claude Code CLI（print mode）"

cd "$WORK_DIR"

EXIT_CODE=0
echo "請執行 /daily-analysis $REPORT_DATE" | "$CLAUDE_BIN" \
  -p \
  --permission-mode bypassPermissions \
  --mcp-config "$MCP_CONFIG" \
  --max-budget-usd 2 \
  --allowedTools "Bash,Read,Write,Edit,Glob,Grep,Skill,WebFetch,mcp__openclaw-server__ssh_exec" \
  2>&1 || EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]]; then
  log "===== 每日營運分析完成 ====="
else
  log "===== 每日營運分析失敗（exit code: $EXIT_CODE）====="
fi

exit $EXIT_CODE
