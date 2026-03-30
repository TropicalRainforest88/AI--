# Daily Digest V2 Design

## Overview

Rewrite the daily agent digest cron job to improve reliability, add OpenAI usage analytics, and provide deeper conversation analysis.

**Current problems:**
- Prompt-driven data collection is unreliable (agent parses .jsonl itself)
- No usage/cost visibility per project
- Long prompt burns ~130K input tokens per run (~$0.30/day)
- No success/failure markers in .jsonl — agent must infer from conversation content
- Hardcoded case categories can't adapt to new business types

**Solution:** Shell script (with Python for JSON processing) handles deterministic data collection; agent handles AI analysis and report writing.

## Architecture

```
[cron 09:00 UTC+8] → agent EXEC → daily-digest.sh
                                    ├── source ~/.openclaw/secrets/openai-admin.sh
                                    ├── OpenAI Usage API (previous day, UTC+8 anchored)
                                    ├── Scan .jsonl sessions (previous day, UTC+8)
                                    ├── Python: three-layer summarization
                                    └── Output structured JSON to stdout
                                  → agent analyzes JSON → writes report → Telegram
```

## Components

### 1. `config/agent-projects.json` — Agent-Project Mapping

Maintains the mapping between OpenClaw agents and OpenAI project IDs.

```json
{
  "projects": [
    { "agent": "main", "projectId": "proj_QVFS0jiJzXDJf7vM859K0CuI", "label": "Main" },
    { "agent": "cams-cryp-pre", "projectId": "proj_ufsiGY2lc5UzGt5TTUkAoSV6", "label": "CAMS/CRYP" },
    { "agent": "cams-cryp-ol", "projectId": "proj_ufsiGY2lc5UzGt5TTUkAoSV6", "label": "CAMS/CRYP" },
    { "agent": "onepay", "projectId": "proj_I9G36J3h09U1PFx2EWaWw9N1", "label": "OnePay" },
    { "agent": "gb-ol", "projectId": "proj_4NEqvRylaTlxVHNAWj3C8mX7", "label": "GB" },
    { "agent": "settlement", "projectId": "proj_IvS2lxV2BOTZuqBvDqWpgref", "label": "Settlement" },
    { "agent": "openclaw-coderevie-ol", "projectId": "proj_QZ9xihc2WP61YAGUiynXRbrn", "label": "CodeReview" }
  ]
}
```

**Note:** Agents on the server that are not listed here (e.g. `camssae_bot`, `codex`) will still have their sessions scanned but will appear as "unmapped" in the output. The script does not fail on unmapped agents.

### 2. `scripts/daily-digest.sh` + `scripts/daily-digest-collect.py` — Data Collection

The shell script is a thin wrapper: sources secrets, sets env vars, invokes Python. All JSON processing and summarization logic lives in `daily-digest-collect.py`.

**Shell script responsibilities:**
- Source `~/.openclaw/secrets/openai-admin.sh` (absolute path)
- Set `OPENCLAW_BASE`, `REPORT_DATE` (previous day in UTC+8)
- Invoke Python script

**Python script responsibilities:**

#### Step A: OpenAI Usage API

Call `GET https://api.openai.com/v1/organization/usage/completions` with:
- `start_time` / `end_time`: Unix epoch seconds, anchored to UTC+8 day boundaries
  - For report date 2026-03-19 (UTC+8): start = 2026-03-18T16:00:00Z, end = 2026-03-19T16:00:00Z
- `group_by`: `["project_id"]`
- Handle pagination via `page` parameter if results exceed one page
- Aggregate per project: input_tokens, output_tokens
- **Cost calculation:** Derive from token counts using model pricing lookup (gpt-5.1-codex: $2/1M input, $8/1M output). Cost is not returned by the API directly.
- Also fetch the day-before-yesterday usage (same API, shifted window) for day-over-day comparison.

Cross-reference with `agent-projects.json` to map project → agent label.

#### Step B: Session Scanning

Find .jsonl files under `~/.openclaw/agents/*/sessions/` where the first `type: "session"` entry's timestamp falls within the report date (UTC+8).

**Exclude cron-generated sessions:** Parse the first `type: "message"` entry with `role: "user"`. If its text content starts with a cron job marker (e.g., contains the cron job name or is a known cron prompt pattern), skip the session. Note: session keys are NOT stored in the .jsonl header — cron sessions are identified by content pattern matching.

For each included session, extract:
- Agent name (from file path: `agents/<agentId>/sessions/`)
- Session ID (from filename)
- Timestamp range (first message → last message)
- Message count by role (user / assistant / toolResult)
- Duration (last timestamp - first timestamp)

#### Step C: Three-Layer Summarization

**Layer 1 — Clean extraction:**
- Extract all `type: "message"` entries
- From `message.content` array, keep only blocks where `type == "text"` or `type == "tool_use"` (input only) or `type == "tool_result"`
- Strip blocks where `type == "thinking"` (these contain encrypted signatures, no analysis value)
- Truncate `tool_result` text content to first 500 chars each
- Truncate `tool_use` input to first 300 chars each

**Layer 2 — Size-based truncation (per session, based on extracted text size):**
- Small sessions (text < 10KB): full content preserved
- Medium sessions (10-50KB): full user messages + assistant text replies truncated to first 1000 chars each
- Large sessions (> 50KB): full user messages + first and last assistant replies in full + middle assistant replies truncated to 200 chars each

**Layer 3 — Budget control:**
- Total text budget: 60KB (~20K tokens, conservative for Chinese-heavy content)
- If Layer 2 output exceeds budget, proportionally truncate sessions by size (largest sessions get cut first)

#### Output Format

Single JSON object to stdout:

```json
{
  "reportDate": "2026-03-19",
  "generatedAt": "2026-03-20T01:00:05Z",
  "usage": {
    "byProject": [
      {
        "label": "Main",
        "projectId": "proj_...",
        "agents": ["main"],
        "inputTokens": 125000,
        "outputTokens": 15000,
        "costUsd": 1.23
      }
    ],
    "totalCostUsd": 5.67,
    "previousDayCostUsd": 4.89
  },
  "sessions": [
    {
      "agent": "cams-cryp-ol",
      "sessionId": "abc123",
      "timeRange": ["2026-03-19T02:15:00Z", "2026-03-19T02:35:00Z"],
      "messageCount": { "user": 3, "assistant": 4, "toolResult": 8 },
      "truncated": false,
      "conversation": [
        { "role": "user", "text": "..." },
        { "role": "assistant", "text": "..." }
      ]
    }
  ],
  "sessionSummary": {
    "totalSessions": 14,
    "byAgent": { "main": 4, "cams-cryp-ol": 2, "onepay": 2, "openclaw-coderevie-ol": 6 }
  }
}
```

**Error output:** If the script encounters a fatal error (missing API key, API failure, no sessions dir), output:
```json
{
  "error": "Description of what went wrong",
  "reportDate": "2026-03-19",
  "generatedAt": "2026-03-20T01:00:05Z"
}
```

### 3. Secret Injection

**GitHub Secret:** `OPENAI_ADMIN_API_KEY`

**deploy.yml addition:**
```yaml
env:
  OPENAI_ADMIN_API_KEY: ${{ secrets.OPENAI_ADMIN_API_KEY }}
```

**deploy.sh `--secrets` stage:**
```bash
printf 'export OPENAI_ADMIN_API_KEY=%s\n' "${OPENAI_ADMIN_API_KEY}" \
  > ${BASE}/secrets/openai-admin.sh && chmod 600 ${BASE}/secrets/openai-admin.sh
```

### 4. Cron Job Update (`config/cron-jobs.json`)

Replace the existing `daily-agent-digest-2100` entry:

```json
{
  "id": "daily-ops-report-0900",
  "agentId": "main",
  "sessionKey": "agent:main:daily-ops-report",
  "name": "Daily Ops Report (09:00 UTC+8)",
  "enabled": true,
  "schedule": {
    "kind": "cron",
    "expr": "0 9 * * *",
    "tz": "Asia/Taipei"
  },
  "sessionTarget": "isolated",
  "wakeMode": "now",
  "payload": {
    "kind": "agentTurn",
    "message": "<prompt — see section 5>"
  },
  "delivery": {
    "mode": "announce",
    "channel": "telegram",
    "to": "957924055"
  }
}
```

**Transition:** Disable the old `daily-agent-digest-2100` job (set `enabled: false`) in the same deployment. Remove it entirely after the new job is verified.

### 5. Agent Prompt (Simplified)

```
你是 OpenClaw 每日營運報告助手。

請執行 daily-digest.sh 取得昨日的結構化資料：
EXEC bash ~/.openclaw/scripts/daily-digest.sh

拿到 JSON 結果後，請分析並撰寫報告：

1. 用量分析：
   - 各 project 的 token 用量和成本，與前日比較
   - 標記異常（增減超過 30% 的 project）

2. 案件分析：
   - 從對話內容判斷每個 session 的案件類型和處理結果
   - 不要硬套分類，根據實際對話內容歸類
   - 特別關注失敗案件的原因和可改善之處

3. 改善建議：
   - 基於失敗場景提出流程改善建議
   - 基於用量異常提出成本優化建議

用繁體中文輸出，格式如下：

📊 每日營運報告 — {日期}

【用量摘要】
表格：Agent | Tokens | 成本(USD) | 較前日

【案件統計】
按類型和結果統計

【重點案件】
值得注意的案件，每個 1-2 行

【異常警示】
用量或案件的異常模式

【改善建議】
具體可行的改善方向

如果腳本執行失敗或回傳 error JSON，回覆錯誤訊息即可。
```

### 6. Deployment

**Scripts deployment:**
- `scripts/daily-digest.sh` → `${BASE}/scripts/daily-digest.sh`
- `scripts/daily-digest-collect.py` → `${BASE}/scripts/daily-digest-collect.py`
- `config/agent-projects.json` → `${BASE}/config/agent-projects.json`

**deploy.sh changes:**
- In `--cron` phase, add:
  ```bash
  mkdir -p ${BASE}/scripts
  scp scripts/daily-digest.sh ${remote}:${BASE}/scripts/
  scp scripts/daily-digest-collect.py ${remote}:${BASE}/scripts/
  ssh ${remote} "chmod +x ${BASE}/scripts/daily-digest.sh"
  ```
- In `--config` phase, add:
  ```bash
  scp config/agent-projects.json ${remote}:${BASE}/config/agent-projects.json
  ```
- In `--secrets` phase, add `openai-admin.sh` injection (see section 3)

## File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `config/agent-projects.json` | Create | Agent-to-OpenAI-project mapping |
| `scripts/daily-digest.sh` | Create | Thin shell wrapper (source secrets, invoke Python) |
| `scripts/daily-digest-collect.py` | Create | Data collection, summarization, JSON output |
| `config/cron-jobs.json` | Modify | Disable old digest, add new daily-ops-report-0900 |
| `.github/workflows/deploy.yml` | Modify | Add OPENAI_ADMIN_API_KEY env var |
| `scripts/deploy.sh` | Modify | Add openai-admin.sh secret + scripts deployment |

## Cost Estimate

- Script execution: ~0 (shell + Python + curl)
- Agent analysis with pre-processed data: ~30-50K input tokens + ~3K output tokens
- Estimated cost: ~$0.10-0.15/day (down from ~$0.30/day)

## Testing Plan

1. Run `daily-digest.sh` manually on server, verify JSON output structure
2. Verify OpenAI Usage API returns expected data format with the admin key
3. Test edge cases: zero sessions, very large sessions, API failures, missing secrets
4. Verify cron session exclusion logic works correctly
5. Run full cron job once manually, verify Telegram delivery
6. Compare report quality with previous digest output
