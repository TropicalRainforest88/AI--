# Daily Digest V2 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unreliable prompt-driven daily digest with a script-based data collection pipeline + AI analysis, adding OpenAI usage analytics per project.

**Architecture:** Shell wrapper sources secrets and invokes Python. Python collects OpenAI Usage API data and .jsonl session summaries, outputs structured JSON. Agent prompt is simplified to only analyze the pre-collected data and write the report.

**Tech Stack:** Bash, Python 3 (stdlib only — json, urllib, os, glob, datetime), OpenAI Admin API, OpenClaw cron system

**Spec:** `docs/superpowers/specs/2026-03-20-daily-digest-v2-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `config/agent-projects.json` | Create | Agent ↔ OpenAI project ID mapping |
| `scripts/daily-digest.sh` | Create | Shell wrapper: source secrets, set env, invoke Python |
| `scripts/daily-digest-collect.py` | Create | Data collection + three-layer summarization + JSON output |
| `config/cron-jobs.json` | Modify | Disable old job, add new `daily-ops-report-0900` |
| `scripts/deploy.sh` | Modify | Add secret injection + script deployment steps |
| `.github/workflows/deploy.yml` | Modify | Add `OPENAI_ADMIN_API_KEY` env var |

---

### Task 1: Create agent-projects.json

**Files:**
- Create: `config/agent-projects.json`

- [ ] **Step 1: Create the mapping file**

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

- [ ] **Step 2: Validate JSON syntax**

Run: `python3 -c "import json; json.load(open('config/agent-projects.json')); print('OK')"`
Expected: `OK`

---

### Task 2: Create daily-digest-collect.py (Python data collector)

**Files:**
- Create: `scripts/daily-digest-collect.py`

This is the core logic. It has three sections: Usage API, Session scanning, and Summarization.

- [ ] **Step 1: Write the Usage API collection module**

The script reads env vars `OPENAI_ADMIN_API_KEY`, `OPENCLAW_BASE`, `REPORT_DATE` (YYYY-MM-DD).

Calls `GET https://api.openai.com/v1/organization/usage/completions`:
- `start_time`/`end_time` as Unix epoch seconds, anchored to UTC+8 boundaries
- `group_by=["project_id"]`
- Handles pagination via `next_page` token
- Also fetches day-before-yesterday for comparison
- Loads `config/agent-projects.json` (at `${OPENCLAW_BASE}/config/agent-projects.json`) to map projectId → label
- Cost calculation: hardcode model pricing (gpt-5.1-codex: $2/1M input, $8/1M output) — can be updated later

On API failure: set `usage.error` field in output, continue with session scanning.

- [ ] **Step 2: Write the Session scanning module**

Scans `${OPENCLAW_BASE}/agents/*/sessions/*.jsonl`:
- Filter files where the first `type: "session"` entry timestamp falls within report date (UTC+8 boundaries)
- Extract agent name from path (`agents/<agentId>/sessions/`)
- Parse each .jsonl line by line
- For cron exclusion: check if first user message text matches known cron patterns (contains the cron job name from the payload, or starts with common cron prompts like "你是 OpenClaw 每日" or "Generate the daily Jira report" or "（低頻兜底檢查）")
- Collect: message counts by role, timestamp range, session ID

- [ ] **Step 3: Write the Three-Layer Summarization**

For each non-cron session:

**Layer 1 — Clean extraction:**
- Keep `type: "message"` entries only
- From `message.content[]`, keep blocks with `type == "text"`
- For `tool_use` blocks: keep `type` + `name` + first 300 chars of `input`
- For `tool_result` blocks: keep first 500 chars of text content
- Drop `thinking`/`thinkingSignature` blocks entirely

**Layer 2 — Size-based truncation (per session text_size):**
- `< 10KB`: keep all
- `10-50KB`: full user messages, assistant text truncated to 1000 chars each
- `> 50KB`: full user messages, first + last assistant reply in full, middle assistant replies truncated to 200 chars each

**Layer 3 — Budget control:**
- Total budget: 60KB
- If over budget after Layer 2: sort sessions by size descending, progressively truncate the largest sessions (reduce to first user message + last assistant message only) until under budget

- [ ] **Step 4: Write the main output assembly**

Combine usage data + session data into the output JSON schema defined in spec.
Print to stdout. All stderr is for logging/debug.

Error wrapper: if any fatal error (missing env var, no agents dir), output `{"error": "...", "reportDate": "..."}`.

- [ ] **Step 5: Test locally with mock data**

Create a small test: mock a .jsonl file structure in /tmp, set env vars, run script.

Run: `OPENCLAW_BASE=/tmp/test-openclaw OPENAI_ADMIN_API_KEY=test REPORT_DATE=2026-03-19 python3 scripts/daily-digest-collect.py 2>/dev/null | python3 -m json.tool`
Expected: Valid JSON output (usage section may have error due to test API key, sessions section should work)

---

### Task 3: Create daily-digest.sh (Shell wrapper)

**Files:**
- Create: `scripts/daily-digest.sh`

- [ ] **Step 1: Write the shell wrapper**

```bash
#!/bin/bash
set -euo pipefail

BASE="${OPENCLAW_BASE:-$HOME/.openclaw}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Source secrets
if [ -f "${BASE}/secrets/openai-admin.sh" ]; then
  source "${BASE}/secrets/openai-admin.sh"
fi

# Calculate report date (yesterday in UTC+8)
export REPORT_DATE=$(TZ=Asia/Taipei date -d 'yesterday' '+%Y-%m-%d' 2>/dev/null || TZ=Asia/Taipei date -v-1d '+%Y-%m-%d')
export OPENCLAW_BASE="$BASE"

# Run Python collector
exec python3 "${SCRIPT_DIR}/daily-digest-collect.py"
```

- [ ] **Step 2: Make executable**

Run: `chmod +x scripts/daily-digest.sh`

---

### Task 4: Update cron-jobs.json

**Files:**
- Modify: `config/cron-jobs.json`

- [ ] **Step 1: Disable old daily-agent-digest-2100 and add new job**

Changes to `config/cron-jobs.json`:
1. Set `"enabled": false` on the job with id `"daily-agent-digest-2100"`
2. Add new job entry after it:

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
    "message": "你是 OpenClaw 每日營運報告助手。\n\n請執行 daily-digest.sh 取得昨日的結構化資料：\nEXEC bash ~/.openclaw/scripts/daily-digest.sh\n\n拿到 JSON 結果後，請分析並撰寫報告：\n\n1. 用量分析：\n   - 各 project 的 token 用量和成本，與前日比較\n   - 標記異常（增減超過 30% 的 project）\n\n2. 案件分析：\n   - 從對話內容判斷每個 session 的案件類型和處理結果\n   - 不要硬套分類，根據實際對話內容歸類\n   - 特別關注失敗案件的原因和可改善之處\n\n3. 改善建議：\n   - 基於失敗場景提出流程改善建議\n   - 基於用量異常提出成本優化建議\n\n用繁體中文輸出，格式如下：\n\n📊 每日營運報告 — {日期}\n\n【用量摘要】\n表格：Agent | Tokens | 成本(USD) | 較前日\n\n【案件統計】\n按類型和結果統計\n\n【重點案件】\n值得注意的案件，每個 1-2 行\n\n【異常警示】\n用量或案件的異常模式\n\n【改善建議】\n具體可行的改善方向\n\n如果腳本執行失敗或回傳 error JSON，回覆錯誤訊息即可。"
  },
  "delivery": {
    "mode": "announce",
    "channel": "telegram",
    "to": "957924055"
  }
}
```

- [ ] **Step 2: Validate JSON syntax**

Run: `python3 -c "import json; json.load(open('config/cron-jobs.json')); print('OK')"`
Expected: `OK`

---

### Task 5: Update deploy.sh for secret injection and script deployment

**Files:**
- Modify: `scripts/deploy.sh`

- [ ] **Step 1: Add openai-admin.sh injection in --secrets phase**

In the `--secrets` block (after the `jira.sh` line, around line 265), add:

```bash
      if [ -n \"${OPENAI_ADMIN_API_KEY:-}\" ]; then
        printf 'export OPENAI_ADMIN_API_KEY=%s\n' \"${OPENAI_ADMIN_API_KEY}\" > ${BASE}/secrets/openai-admin.sh && chmod 600 ${BASE}/secrets/openai-admin.sh
      fi
```

Update the echo on line 282 to include `openai-admin.sh`.

- [ ] **Step 2: Add script deployment in --cron phase**

In the `--cron` block (after line 303, before `echo "    -> cron jobs deployed"`), add:

```bash
    # Deploy digest scripts
    $ssh_cmd "${remote}" "mkdir -p ${BASE}/scripts ${BASE}/config"
    $scp_cmd "$PROJECT_DIR/scripts/daily-digest.sh" "${remote}:${BASE}/scripts/daily-digest.sh"
    $scp_cmd "$PROJECT_DIR/scripts/daily-digest-collect.py" "${remote}:${BASE}/scripts/daily-digest-collect.py"
    $ssh_cmd "${remote}" "chmod +x ${BASE}/scripts/daily-digest.sh"
    $scp_cmd "$PROJECT_DIR/config/agent-projects.json" "${remote}:${BASE}/config/agent-projects.json"
```

- [ ] **Step 3: Verify deploy.sh syntax**

Run: `bash -n scripts/deploy.sh`
Expected: No output (no syntax errors)

---

### Task 6: Update deploy.yml to pass OPENAI_ADMIN_API_KEY

**Files:**
- Modify: `.github/workflows/deploy.yml`

- [ ] **Step 1: Add env var to .env creation step**

In the `Create .env` step, add after line 66 (`echo "OPENAI_API_KEY_SETTLEMENT=$OPENAI_API_KEY_SETTLEMENT" >> .env`):

```yaml
          echo "OPENAI_ADMIN_API_KEY=$OPENAI_ADMIN_API_KEY" >> .env
```

And in the `env:` block, add:

```yaml
          OPENAI_ADMIN_API_KEY: ${{ secrets.OPENAI_ADMIN_API_KEY }}
```

- [ ] **Step 2: Validate YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy.yml')); print('OK')" 2>/dev/null || python3 -c "print('pyyaml not installed, skip')"`

---

### Task 7: Verify and commit

- [ ] **Step 1: Verify all files**

Run:
```bash
python3 -c "import json; json.load(open('config/agent-projects.json')); print('agent-projects.json OK')"
python3 -c "import json; json.load(open('config/cron-jobs.json')); print('cron-jobs.json OK')"
bash -n scripts/deploy.sh && echo "deploy.sh OK"
python3 -c "import py_compile; py_compile.compile('scripts/daily-digest-collect.py', doraise=True); print('Python OK')"
test -x scripts/daily-digest.sh && echo "daily-digest.sh executable OK"
```

Expected: All OK

- [ ] **Step 2: Create branch and commit**

```bash
git checkout -b feat/daily-digest-v2
git add config/agent-projects.json scripts/daily-digest.sh scripts/daily-digest-collect.py config/cron-jobs.json scripts/deploy.sh .github/workflows/deploy.yml
git commit -m "feat: rewrite daily digest with script-based data collection and OpenAI usage analytics

- Add scripts/daily-digest.sh + daily-digest-collect.py for deterministic data collection
- Add config/agent-projects.json for agent-to-OpenAI-project mapping
- Update cron-jobs.json: disable old digest, add daily-ops-report-0900 (09:00 UTC+8)
- Update deploy.sh: inject OPENAI_ADMIN_API_KEY secret, deploy digest scripts
- Update deploy.yml: pass OPENAI_ADMIN_API_KEY to .env"
```

---

## Post-Deploy Verification

After merging and deploying:

1. SSH to server, verify files exist:
   - `~/.openclaw/scripts/daily-digest.sh` (executable)
   - `~/.openclaw/scripts/daily-digest-collect.py`
   - `~/.openclaw/config/agent-projects.json`
   - `~/.openclaw/secrets/openai-admin.sh`
2. Run manually: `bash ~/.openclaw/scripts/daily-digest.sh` — verify JSON output
3. Wait for 09:00 UTC+8 cron trigger, verify Telegram delivery
4. After verification, remove the disabled `daily-agent-digest-2100` entry from cron-jobs.json

## GitHub Secret Required

Before deploying, add to GitHub repo secrets:
- **Name:** `OPENAI_ADMIN_API_KEY`
- **Value:** (the OpenAI Organization Admin API key provided by the user)
