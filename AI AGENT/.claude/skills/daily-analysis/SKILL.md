---
name: daily-analysis
description: 每日營運分析 — 收集成本與 session 資料、證據優先分析、gh-pages 報告、Telegram 通知
user_invocable: true
---

# 每日營運分析

產出指定日期的 OpenClaw 每日營運報告。

## 使用方式

```
/daily-analysis              # 分析昨天
/daily-analysis 2026-03-20   # 分析指定日期
```

## 核心原則

**證據優先，主動判斷，禁止空泛。**

- 所有數字必須來自實際 API 回應或 session 資料，禁止腦補
- 建議必須具體到可執行，引用具體 session ID、對話內容或數據
- 不要寫「調查 XX」，要寫「XX 平均每次 90K tokens，建議改為 YY 可減少 ZZ%」
- 對有用量但無 session 紀錄的 project，明確標記「無 session 紀錄，無法分析」，不要猜測用途

## Phase 1：資料收集

### 1a. 日期與時間計算

確定報告日期 REPORT_DATE（環境變數或昨天 UTC）。

計算 UTC 日邊界的 Unix epoch：
```bash
# 必須用指令計算，禁止手動推算
python3 -c "from datetime import datetime,timezone; d=datetime(2026,3,20,tzinfo=timezone.utc); print(int(d.timestamp()))"
```

- `start_ts`：REPORT_DATE 00:00:00 UTC 的 epoch seconds
- `end_ts`：REPORT_DATE+1 00:00:00 UTC 的 epoch seconds

**注意：年份是 2026，不是 2025。用錯年份會導致成本數據完全錯誤。**

### 1b. 成本資料（本機收集）

用環境變數 `OPENAI_ADMIN_API_KEY` 呼叫 OpenAI API：

**當日成本：**
```
GET https://api.openai.com/v1/organization/costs
  ?start_time={start_ts}&end_time={end_ts}&group_by[]=project_id
Authorization: Bearer $OPENAI_ADMIN_API_KEY
```

**當日 token 用量：**
```
GET https://api.openai.com/v1/organization/usage/completions
  ?start_time={start_ts}&end_time={end_ts}&group_by[]=project_id
Authorization: Bearer $OPENAI_ADMIN_API_KEY
```

**前日成本（用於比較）：**
```
GET https://api.openai.com/v1/organization/costs
  ?start_time={start_ts - 86400}&end_time={start_ts}&group_by[]=project_id
```

合併三個 API 回應，按 project_id 彙整：成本、token 數、較前日變化。

**Project label 對照：** 用 SSH 讀取 server 上的 `config/agent-projects.json` 來對應 project_id → agent label。

### 1c. Session 資料（SSH 遠端收集）

用 SSH MCP 連線到 server，執行 collect.py 取得 session 摘要：
```bash
REPORT_DATE={date} python3 ~/openclaw-op/scripts/daily-digest-collect.py
```

collect.py 在沒有 OPENAI_ADMIN_API_KEY 時會跳過成本收集，只輸出 session 資料。

## Phase 2：分析

### 概覽分析

基於 Phase 1 收集的成本和 session 摘要資料：

1. **成本分析**：按 project 分列成本、token 數、cache rate、較前日變化
2. **異常標記**：增減超過 30% 的 project 標記異常
3. **案件分類**：從對話內容判斷每個 session 的類型和處理結果（不要硬套分類）
4. **失敗案件**：特別關注失敗案件的原因
5. **交叉分析**（成本 × session 內容）：將成本異常與實際對話內容關聯，解釋原因

### 深入分析（Phase 2b）

標記最多 5 個需要深入調查的 session（例如失敗案件、異常用量、重要決策）。

對標記的 session，用 SSH 讀取原始 .jsonl 檔案的完整內容：
```bash
# 路徑格式：~/.openclaw/agents/{agentId}/sessions/{sessionId}.jsonl
```

從完整對話中挖掘：
- 具體的失敗原因和可改善步驟
- 量化的效率數據（token 消耗、重試次數）
- 可實施的具體建議（引用 session ID 和對話內容）

## Phase 3：報告輸出（gh-pages）

產出 Markdown 格式報告，推送到 gh-pages 分支。

### 報告結構

```markdown
---
layout: default
title: "OpenClaw 每日營運報告 — {REPORT_DATE}"
---

# OpenClaw 每日營運報告 — {REPORT_DATE}

## 摘要
關鍵數字一覽（成本、session 數、PR 數等）

## 成本分析

Mermaid 圓餅圖展示各 project 成本分佈：
~~~
```mermaid
pie title 成本分佈 (USD)
  "Project A" : 11.57
  "Project B" : 6.63
  ...
```
~~~

表格：Project | 成本(USD) | Requests | Input Tokens | Cache Rate | 較前日
標記異常項目（漲跌超過 30% 用 ⚠️ 標記）

## 案件活動
按類型統計（PR review、用戶互動、部署等）

## 重點案件
值得注意的案件，引用具體 session ID，每個 2-3 行

## 深入分析
Phase 2b 的詳細發現，引用對話內容，量化數據

## 異常警示
用量或案件的異常模式

## 建議與行動項目
具體可行的改善方向，引用數據和 session
```

### gh-pages 推送流程

1. 用 git worktree 建立 gh-pages 工作區（或切換到既有的）
2. 將報告存為 `{REPORT_DATE}.html`（Jekyll 會處理 markdown → HTML）
3. 更新 `index.md` 加入新報告連結
4. commit 並 push
5. 清理 worktree

**注意：GitHub Pages 連結要用 `.html` 後綴，不是 `.md`。**

報告連結格式：`https://sitruc-workshop.github.io/openclaw_op/{REPORT_DATE}.html`

## Phase 4：Telegram 通知

用 Telegram Bot API 發送摘要通知：

```
POST https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage
```

參數：
- `chat_id`: `-5190882894`（Openclaw_OP_代碼審查群組）
- `parse_mode`: `HTML`
- `text`: 摘要內容

### 通知格式

```
📊 <b>每日營運報告 — {REPORT_DATE}</b>

💰 成本：${total} ({change}%)
📋 Sessions：{count}
🔍 PR 審查：{pr_count}

🔗 <a href="https://sitruc-workshop.github.io/openclaw_op/{REPORT_DATE}.html">完整報告</a>
```

**注意：HTML 格式要轉義 `<` `>` `&` 等特殊字元。**
