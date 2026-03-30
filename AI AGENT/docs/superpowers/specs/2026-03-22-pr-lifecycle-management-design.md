# PR 生命週期管理系統 — Design Spec

Status: Draft
Date: 2026-03-22

## Problem

目前 PR 從建立到部署驗證的流程缺乏明確的狀態追蹤。PR merge 後即關閉，但部署和驗證是在 merge 之後才發生的。當多個 PR 同時進行時，容易遺漏哪些 PR 已部署但尚未驗證，導致潛在問題未被及時發現。

## Solution

透過 GitHub Labels 建立完整的 PR 生命週期狀態機，搭配 GitHub Actions 自動化狀態轉換、deploy 後 Telegram 通知含測項、定時提醒未驗證 PR，以及 AI 驅動的 post-deploy 驗證 skill。

## Lifecycle State Machine

```
PR opened/push commits
    → [review]
        → agent review
            → [approved] (通過)
            → [need-change] (需修改)
                → push fixes → [review] (回流)
    → merge
    → deploy
        → [deployed] + [awaiting-verification]
        → 打 tag deploy-YYYYMMDD-HHMMSS
        → Telegram 通知 + 測項列表
    → /verify-pr #N
        → AI 逐項驗證（需實證）
        → [verified] (全部通過)
```

## Labels

| Label | 色碼 | 顏色 | 說明 |
|-------|------|------|------|
| `review` | `#FBCA04` | 黃色 | 等待 review |
| `need-change` | `#E11D48` | 紅色 | 需要修改 |
| `approved` | `#22C55E` | 綠色 | Review 通過 |
| `deployed` | `#3B82F6` | 藍色 | 已部署到 server |
| `awaiting-verification` | `#F97316` | 橘色 | 等待 post-deploy 驗證 |
| `verified` | `#166534` | 深綠色 | 驗證通過 |

每次狀態轉換時，移除前一狀態的 label，加上新狀態的 label。

## Components

### 1. PR Label Lifecycle Workflow（新增）

- **Path**: `.github/workflows/pr-label-lifecycle.yml`
- **Trigger**: `pull_request` types `[opened, synchronize, reopened]`
- **行為**:
  - 加上 `review` label
  - 移除 `need-change` label（若存在）
- **用途**: PR 建立或 push 新 commit 時自動回到 review 狀態
- **Permissions**: `pull-requests: write`

### 2. Agent Code Review Label 整合（修改現有）

- **Path**: `workspaces/openclaw-coderevie-ol/skills/code-review/SKILL.md`
- **修改方式**: 在 agent 的 review skill 中加入 GitHub API label 操作
- **行為**:
  - Review 結果為通過 → 透過 GitHub API 加 `approved`、移除 `review`
  - Review 結果為需修改 → 透過 GitHub API 加 `need-change`、移除 `review`

#### 實作方案

Agent 本身可操作 GitHub API，因此 label 操作直接由 agent 在 review 結束時執行，不需要額外的 workflow。

流程：
1. `pr-codereview.yml` 觸發 agent review（現有邏輯，不修改）
2. Agent 完成 review 後：
   - 在 PR 留 comment（現有邏輯）
   - 根據 review 結論，呼叫 GitHub API 更新 label

需修改 agent 的 review skill，在結論區塊後加入 label 操作指示：
- 若結論為 Approve → 呼叫 GitHub API: `POST /repos/{owner}/{repo}/issues/{number}/labels` 加上 `approved`，`DELETE /repos/{owner}/{repo}/issues/{number}/labels/{name}` 移除 `review`
- 若結論為 Request Changes → 同上邏輯，加 `need-change`、移除 `review`

**注意**: 需確認 agent 目前可用的 GitHub API 工具名稱，並在 skill 中明確指示使用方式。

### 3. Deploy Workflow 增強（修改現有）

- **Path**: `.github/workflows/deploy.yml`
- **新增行為**（deploy 成功後）:

#### 3a. 找出包含的 PR（先於打 tag）

**重要**: 必須先偵測 PR 再打 tag，否則新 tag 會指向 HEAD，導致範圍比對為空。

```bash
PREV_TAG=$(git tag -l 'deploy-*' --sort=-creatordate | head -1)
if [ -z "$PREV_TAG" ]; then
  # 第一次 deploy，無前一個 tag，跳過 PR 偵測
  PRS=""
else
  PRS=$(git log ${PREV_TAG}..HEAD --merges --oneline | grep -oE '#[0-9]+' | grep -oE '[0-9]+')
fi
```

#### 3b. 自動打 Tag

```bash
TAG="deploy-$(date -u +%Y%m%d-%H%M%S)"
git tag "$TAG"
git push origin "$TAG"
```

Tag 格式包含秒數（`deploy-YYYYMMDD-HHMMSS`），避免同分鐘多次 deploy 的衝突。

#### 3c. 更新 PR Label

```bash
for pr in $PRS; do
  gh pr edit "$pr" --add-label "deployed" --add-label "awaiting-verification" --remove-label "approved"
done
```

#### 3d. Telegram 通知含測項

對每個 PR，從 PR body 擷取 `## Post-Deploy 驗證` 區塊：

```bash
for pr in $PRS; do
  BODY=$(gh pr view "$pr" --json body --jq '.body')
  # 擷取 Post-Deploy 驗證區塊
  CHECKLIST=$(echo "$BODY" | sed -n '/## Post-Deploy 驗證/,/^## /p' | head -n -1)
  # 組合到 Telegram 訊息中
done
```

Telegram 訊息格式：
```html
🚀 <b>部署完成</b>
🏷️ Tag: deploy-20260322-0030

<b>包含的 PR：</b>

<b>#63</b> feat: add pr-approved-reminder
📋 驗證項目：
  • 確認 cron job 排程正確
  • 確認 Telegram 通知有發送
  • 確認 label 自動加上

<b>#65</b> fix: deploy script retry
📋 驗證項目：
  • 確認 deploy 重試邏輯正常
  • 確認 SSH 連線穩定

⏳ 請使用 <code>/verify-pr</code> 進行驗證
```

- **Permissions**: 需新增 `contents: write`（打 tag）、`pull-requests: write`（改 label）

### 4. Push-PR Skill 修改（修改現有）

- **Path**: `.claude/skills/push-pr/SKILL.md`
- **修改內容**:
  - 將 `## 測試確認` 區塊改為 `## Post-Deploy 驗證`
  - 根據變更內容自動產生具體測項，而非通用 checklist
  - 需 commit 到 git 供共同開發者使用

#### 測項產生規則

根據變更的檔案類型和內容，產生對應的驗證項目：

| 變更類型 | 測項範例 |
|----------|----------|
| `config/cron-jobs.json` | 確認 cron job 排程已更新（`crontab -l` 驗證） |
| `config/openclaw.json` | 確認 config 已生效（檢查遠端檔案內容） |
| `workspaces/**/skills/**` | 確認 skill 已部署（檢查遠端 skill 檔案存在且內容正確） |
| `workspaces/**/SOUL.md` | 確認 SOUL.md 已更新（比對遠端檔案） |
| `.github/workflows/**` | 確認 workflow 可正常觸發（手動 dispatch 測試或等待下次觸發） |
| `scripts/**` | 確認腳本已部署且可執行 |

Skill 應根據 diff 內容產生更具體的測項，例如修改了 Telegram 通知邏輯，則測項應為「確認 Telegram 通知格式正確且有收到」。

### 5. Verify-PR Skill（新增）

- **Path**: `.claude/skills/verify-pr/SKILL.md`
- **觸發**: 使用者說 `/verify-pr #63` 或類似指令
- **Allowed Tools**: Bash, Read, Grep, Glob, AskUserQuestion, `mcp__openclaw-server__ssh_exec`, `mcp__openclaw-server__ssh_read_file`, `mcp__openclaw-server__ssh_list_dir`

#### 流程

1. **讀取測項**: `gh pr view #N --json body` 擷取 `## Post-Deploy 驗證` 區塊
2. **逐項驗證**: 對每個測項執行對應的驗證指令（SSH 到 server 檢查）
3. **收集實證**: 每項驗證必須有實證（指令輸出、檔案內容截取等）
4. **結果處理**:
   - **通過的測項**: 在 PR 留 comment，包含每項的實證記錄
   - **未通過的測項**: 輸出給使用者，說明無法驗證的原因，不寫入 PR
5. **Label 操作**:
   - **全部通過**: `gh pr edit --add-label verified --remove-label deployed --remove-label awaiting-verification`
   - **有未通過**: 不變更 label，由使用者決定下一步

#### 驗證 Comment 格式

```markdown
## ✅ Post-Deploy 驗證通過

驗證時間: 2026-03-22 10:30 UTC+8
驗證者: Claude Code

### 測項結果

- [x] 確認 cron job 排程正確
  ```
  $ crontab -l | grep daily-digest
  0 2 * * * /opt/openclaw/scripts/daily-digest.sh
  ```

- [x] 確認 Telegram 通知有發送
  ```
  最近一次通知時間: 2026-03-22 10:00 UTC+8
  訊息內容: ⏳ 待處理 PR 提醒...
  ```
```

### 6. Awaiting-Verification Reminder Workflow（新增）

- **Path**: `.github/workflows/awaiting-verification-reminder.yml`
- **Trigger**: `schedule` cron `0 2,6,9 * * 1-5`（UTC，= UTC+8 10/14/17 weekdays）
- **Also**: `workflow_dispatch` for manual testing
- **行為**: 查詢帶有 `awaiting-verification` label 的 PR（含已 merged），發送 Telegram 提醒
- **Permissions**: `pull-requests: read`

#### Query Logic

```bash
# 搜尋帶有 awaiting-verification label 的 PR（包含已關閉的，限近 7 天內 merge）
CUTOFF=$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-7d +%Y-%m-%dT%H:%M:%SZ)
gh pr list --state all --label "awaiting-verification" --json number,title,url,mergedAt \
  --jq "[.[] | select(.mergedAt > \"$CUTOFF\")]"
```

加上 7 天截止日期，防止因 label 清理失敗導致舊 PR 持續出現在提醒中。

#### Notification Format

```html
🔍 <b>待驗證 PR 提醒</b>

<b>#63</b> feat: add pr-approved-reminder
   🕐 部署後等待 5 小時
   🔗 <a href="...">#63</a>

<b>#65</b> fix: deploy script retry
   🕐 部署後等待 2 小時
   🔗 <a href="...">#65</a>

💡 使用 <code>/verify-pr #N</code> 進行驗證
```

- 發送目標: `TELEGRAM_REMINDER_CHAT_ID`（repository variable，與 pr-approved-reminder 共用）
- 無待驗證 PR 時不發送

## Design Decisions

### 為什麼 review label 由 agent 直接操作？

Agent 本身可操作 GitHub API，由 agent 在 review 結束時直接打 label，流程最簡潔且決定權在 agent 手上。不需要額外的 workflow 監聽或解析 comment。其他 label（deployed、awaiting-verification）由 deploy workflow 操作，因為那些是 deploy 事件觸發的。

### 為什麼測項由 push-pr skill 產生而非 agent review 時產生？

推 PR 的人（AI）最了解變更內容和預期行為，由推 PR 時就定義好驗證標準，確保測項與變更直接對應。Agent review 專注於程式碼品質，不負責定義驗證項目。

### 為什麼 verify-pr 只在 PR comment 留通過記錄？

通過的測項需要留存作為驗證紀錄（audit trail）。未通過的測項輸出給使用者即可，因為還需要後續處理，寫入 PR 反而造成噪音。

### 為什麼用 deploy tag 而非其他方式追蹤 deploy 範圍？

Git tag 是最簡單可靠的方式，不需要額外的狀態儲存。`deploy-YYYYMMDD-HHmm` 格式兼顧可讀性和精確度，同天多次 deploy 不會衝突。

## Required Secrets & Variables

| Name | Type | Status | Purpose |
|------|------|--------|---------|
| `TELEGRAM_BOT_TOKEN` | Secret | Exists | Telegram Bot API |
| `GITHUB_TOKEN` | Auto | Auto-provided | gh CLI |
| `TELEGRAM_REMINDER_CHAT_ID` | Variable | Exists | 提醒通知目標 chat |

## Error Handling

- **Tag 格式含秒數**: `deploy-YYYYMMDD-HHMMSS` 避免同分鐘衝突
- **PR body 無測項區塊**: Telegram 通知顯示「無驗證項目」，label 仍正常更新
- **Agent 未打 label**: 若 agent review 時 GitHub API 呼叫失敗，label 不會更新，需人工介入
- **SSH 驗證失敗**: verify-pr skill 報告無法驗證的原因，不打 verified label
- **PR 關閉未 merge**: 不觸發任何 label 變更，label 自然保留但不影響流程
- **過渡期相容**: deploy workflow 擷取測項時同時檢查 `## Post-Deploy 驗證` 和舊的 `## 測試確認` 區塊名稱

## Label 初始化

首次執行前需建立所有 label（冪等操作，可重複執行）：

```bash
gh label create "review" --color "FBCA04" --description "等待 review" --force
gh label create "need-change" --color "E11D48" --description "需要修改" --force
gh label create "approved" --color "22C55E" --description "Review 通過" --force
gh label create "deployed" --color "3B82F6" --description "已部署到 server" --force
gh label create "awaiting-verification" --color "F97316" --description "等待 post-deploy 驗證" --force
gh label create "verified" --color "166534" --description "驗證通過" --force
```

## 與現有 pr-approved-reminder 的關係

現有 `pr-approved-reminder.yml` 透過 GitHub review API 的 `reviewDecision == APPROVED` 查詢。新系統引入 `approved` label。兩者可共存：

- `pr-approved-reminder.yml` 繼續使用 review API（查 open PR），不受 label 影響
- Label 系統用於追蹤完整生命週期（含 merge 後的階段）

未來可考慮將 `pr-approved-reminder` 改為查 `approved` label 以統一機制，但不在本次範圍內。

## Non-Goals

- 自動 merge（Curtis 需人工判斷 merge 時機）
- 自動 rollback（驗證失敗需人工決策）
- 跨 repo label 同步
- PR body 以外的測項來源
