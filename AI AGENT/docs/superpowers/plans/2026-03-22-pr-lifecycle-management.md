# PR 生命週期管理系統 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立完整的 PR 生命週期 label 追蹤系統，從 review 到 deploy 後驗證，搭配 Telegram 通知和 AI 驅動的驗證 skill。

**Architecture:** GitHub Labels 作為狀態機，GitHub Actions workflows 驅動自動狀態轉換，OpenClaw agent 負責 review label，Claude Code skills 負責 PR 推送和 post-deploy 驗證。

**Tech Stack:** GitHub Actions, GitHub REST API, Telegram Bot API, Bash, gh CLI

**Spec:** `docs/superpowers/specs/2026-03-22-pr-lifecycle-management-design.md`

---

## File Structure

| 動作 | 檔案 | 職責 |
|------|------|------|
| Create | `.github/workflows/pr-label-lifecycle.yml` | PR open/push 時自動加 `review` label |
| Modify | `workspaces/openclaw-coderevie-ol/skills/code-review/SKILL.md` | Agent review 後打 `approved` 或 `need-change` label |
| Modify | `.github/workflows/deploy.yml` | Deploy 後打 tag、更新 label、Telegram 通知含測項 |
| Modify | `.claude/skills/push-pr/SKILL.md` | PR body 改用具體 post-deploy 驗證項目 |
| Create | `.claude/skills/verify-pr/SKILL.md` | AI 驅動的 post-deploy 驗證 |
| Create | `.github/workflows/awaiting-verification-reminder.yml` | 定時提醒未驗證 PR |

---

### Task 1: 建立 GitHub Labels

**Files:**
- None (gh CLI 操作)

- [ ] **Step 1: 建立所有 lifecycle labels**

```bash
gh label create "review" --color "FBCA04" --description "等待 review" --force
gh label create "need-change" --color "E11D48" --description "需要修改" --force
gh label create "approved" --color "22C55E" --description "Review 通過" --force
gh label create "deployed" --color "3B82F6" --description "已部署到 server" --force
gh label create "awaiting-verification" --color "F97316" --description "等待 post-deploy 驗證" --force
gh label create "verified" --color "166534" --description "驗證通過" --force
```

- [ ] **Step 2: 驗證 labels 已建立**

```bash
gh label list | grep -E "review|need-change|approved|deployed|awaiting-verification|verified"
```

Expected: 6 個 label 都出現在列表中。

- [ ] **Step 3: Commit（無檔案變更，僅記錄）**

Labels 建在 GitHub repo 設定中，無需 commit。

---

### Task 2: PR Label Lifecycle Workflow

**Files:**
- Create: `.github/workflows/pr-label-lifecycle.yml`

- [ ] **Step 1: 建立 workflow 檔案**

```yaml
name: PR Label Lifecycle

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  pull-requests: write

jobs:
  label:
    runs-on: ubuntu-latest
    if: github.event.pull_request.draft == false
    steps:
      - name: Add review label
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          PR_NUMBER=${{ github.event.pull_request.number }}
          REPO=${{ github.repository }}

          # Add review label
          gh pr edit "$PR_NUMBER" --repo "$REPO" --add-label "review"

          # Remove need-change if exists (returning to review after fixes)
          gh pr edit "$PR_NUMBER" --repo "$REPO" --remove-label "need-change" 2>/dev/null || true
```

- [ ] **Step 2: 驗證 YAML 語法**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/pr-label-lifecycle.yml'))"
```

Expected: 無錯誤輸出。

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/pr-label-lifecycle.yml
git commit -m "ci: 新增 PR label lifecycle workflow — PR open/push 時自動加 review label"
```

---

### Task 3: Agent Code Review Label 整合

**Files:**
- Modify: `workspaces/openclaw-coderevie-ol/skills/code-review/SKILL.md`

- [ ] **Step 1: 讀取現有 SKILL.md 確認結構**

確認檔案中「6. Submit PR Review」區塊的位置（約第 99-115 行），以及「Merge & Deploy 工作流程」區塊。

- [ ] **Step 2: 在 Submit PR Review 區塊後新增 Label 操作段落**

在第 115 行（`Request Changes` curl 範例結束後）插入新段落：

```markdown
### 7. Update PR Labels (After Review)

Review 完成後，**必須**根據結論更新 PR label。這是 review 流程的一部分，不可跳過。

**Approve 時：**
```bash
# Add approved label
curl -s -X POST \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/sitruc-workshop/openclaw_op/issues/{number}/labels" \
  -d '{"labels": ["approved"]}'

# Remove review label
curl -s -X DELETE \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/sitruc-workshop/openclaw_op/issues/{number}/labels/review"
```

**Request Changes 時：**
```bash
# Add need-change label
curl -s -X POST \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/sitruc-workshop/openclaw_op/issues/{number}/labels" \
  -d '{"labels": ["need-change"]}'

# Remove review label
curl -s -X DELETE \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/sitruc-workshop/openclaw_op/issues/{number}/labels/review"
```

**重要**：Label 操作使用 Issues API（`/issues/{number}/labels`），不是 Pulls API。GitHub PR 的 label 透過 Issues endpoint 管理。DELETE 移除 label 時，若 label 不存在會回傳 404，可忽略。
```

- [ ] **Step 3: 更新原有的 section 編號**

逐一修改以下 section 標題：
- `### 7. Merge PR` → `### 8. Merge PR`
- `### 8. Trigger Deploy Workflow` → `### 9. Trigger Deploy Workflow`
- `### 9. Check Workflow Run Status` → `### 10. Check Workflow Run Status`
- `### 10. Get File Content (for Deep Review)` → `### 11. Get File Content (for Deep Review)`

- [ ] **Step 4: 驗證檔案格式正確**

讀取修改後的檔案，確認 markdown 結構完整，所有 code block 正確關閉。

- [ ] **Step 5: Commit**

```bash
git add workspaces/openclaw-coderevie-ol/skills/code-review/SKILL.md
git commit -m "feat: agent review 完後自動更新 PR label（approved/need-change）"
```

---

### Task 4: Deploy Workflow 增強

**Files:**
- Modify: `.github/workflows/deploy.yml`

- [ ] **Step 1: 新增 permissions 區塊並修改 checkout depth**

在 `jobs:` 之前（第 22 行後）加入：

```yaml
permissions:
  contents: write
  pull-requests: write
```

同時修改 `actions/checkout@v4` step（第 27-29 行），加入 `fetch-depth: 0` 以取得完整 git history（tag 偵測和 PR 比對需要）：

```yaml
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.inputs.ref || github.ref }}
          fetch-depth: 0
```

- [ ] **Step 2: 在 Health Check 和 Notify Telegram 之間新增 PR Tracking step**

在 `Health Check` step（約第 158 行）之後、`Notify Telegram` step 之前，插入新 step：

```yaml
      - name: PR Tracking (Tag + Labels)
        if: steps.deploy.outcome == 'success'
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          # 1. Find PRs included in this deploy (before creating tag)
          PREV_TAG=$(git tag -l 'deploy-*' --sort=-creatordate | head -1)
          if [ -n "$PREV_TAG" ]; then
            PRS=$(git log ${PREV_TAG}..HEAD --merges --oneline | grep -oE '#[0-9]+' | grep -oE '[0-9]+' | sort -u)
          else
            PRS=""
          fi

          # Also include manually specified PR
          MANUAL_PR="${{ github.event.inputs.pr_number }}"
          if [ -n "$MANUAL_PR" ]; then
            PRS=$(printf "%s\n%s" "$PRS" "$MANUAL_PR" | sort -u | grep -v '^$')
          fi

          # 2. Create deploy tag
          TAG="deploy-$(date -u +%Y%m%d-%H%M%S)"
          git tag "$TAG"
          git push origin "$TAG"
          echo "deploy_tag=$TAG" >> "$GITHUB_OUTPUT"

          # 3. Update PR labels
          for pr in $PRS; do
            gh pr edit "$pr" --add-label "deployed" --add-label "awaiting-verification" --remove-label "approved" 2>/dev/null || true
          done

          # 4. Collect verification items for Telegram (write directly to file)
          > /tmp/verify_msg.txt
          for pr in $PRS; do
            PR_TITLE=$(gh pr view "$pr" --json title --jq '.title' 2>/dev/null || echo "")
            PR_BODY=$(gh pr view "$pr" --json body --jq '.body' 2>/dev/null || echo "")

            # Extract Post-Deploy verification section (try both old and new names)
            CHECKLIST=$(echo "$PR_BODY" | awk '/^## Post-Deploy 驗證/{found=1;next} /^## /{found=0} found')
            if [ -z "$CHECKLIST" ]; then
              CHECKLIST=$(echo "$PR_BODY" | awk '/^## 測試確認/{found=1;next} /^## /{found=0} found')
            fi

            # Convert markdown checklist to bullet points for Telegram
            if [ -n "$CHECKLIST" ]; then
              ITEMS=$(echo "$CHECKLIST" | grep -E '^\s*-\s*\[' | sed 's/^\s*-\s*\[.\]\s*/  • /')
            else
              ITEMS="  • 無驗證項目"
            fi

            printf '<b>#%s</b> %s\n📋 驗證項目：\n%s\n\n' "$pr" "$PR_TITLE" "$ITEMS" >> /tmp/verify_msg.txt
          done

          echo "included_prs=$PRS" >> "$GITHUB_OUTPUT"
```

- [ ] **Step 3: 修改 Notify Telegram step 加入驗證項目**

修改現有的 `Notify Telegram` step（第 160-215 行），在訊息末尾加入驗證項目。

在第 207 行的 `MSG=$(printf ...)` 之後、`curl` 之前加入：

```bash
          # Append verification items if deploy succeeded
          if [ "$DEPLOY_STATUS" = "success" ] && [ -f /tmp/verify_msg.txt ]; then
            VERIFY_ITEMS=$(cat /tmp/verify_msg.txt)
            if [ -n "$VERIFY_ITEMS" ]; then
              TAG="${{ steps.pr_tracking.outputs.deploy_tag }}"
              MSG="${MSG}\n\n🏷️ <b>Tag:</b> ${TAG}\n\n<b>包含的 PR：</b>\n${VERIFY_ITEMS}⏳ 請使用 <code>/verify-pr</code> 進行驗證"
            fi
          fi
```

同時將 PR Tracking step 的 `id` 設為 `pr_tracking`：
```yaml
      - name: PR Tracking (Tag + Labels)
        id: pr_tracking
```

- [ ] **Step 4: 驗證 YAML 語法**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy.yml'))"
```

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: deploy 後自動打 tag、更新 PR label、Telegram 通知含驗證項目"
```

---

### Task 5: Push-PR Skill 修改

**Files:**
- Modify: `.claude/skills/push-pr/SKILL.md`

- [ ] **Step 1: 修改 PR Body 模板中的測試確認區塊**

將第 191-193 行的：

```markdown
    ## 測試確認
    - [ ] 確認變更內容正確
    - [ ] 確認無敏感資訊外洩
```

替換為：

```markdown
    ## Post-Deploy 驗證
    {根據變更內容產生具體驗證項目，規則如下}
```

- [ ] **Step 2: 在 PR Body 模板的 code block 外、第 14 步之前，新增測項產生規則**

這段規則是給 AI 的指示，放在 PR body template 的 code block **外面**（約第 194 行 ``` 結束後、第 196 行「建立 PR」之前）：

```markdown
    **Post-Deploy 驗證項目產生規則**：

    根據變更檔案類型和 diff 內容，產生具體可驗證的測項：

    | 變更類型 | 驗證項目格式 |
    |----------|-------------|
    | `config/cron-jobs.json` | `- [ ] 確認 cron job 排程已更新（SSH 執行 crontab -l 驗證）` |
    | `config/openclaw.json` | `- [ ] 確認 config 已生效（SSH 比對遠端 openclaw.json 相關區塊）` |
    | `workspaces/**/skills/**` | `- [ ] 確認 {skill-name} skill 已部署（SSH 檢查遠端檔案存在且內容正確）` |
    | `workspaces/**/SOUL.md` | `- [ ] 確認 {workspace} SOUL.md 已更新（SSH 比對遠端檔案）` |
    | `.github/workflows/**` | `- [ ] 確認 {workflow-name} workflow 可正常觸發` |
    | `scripts/**` | `- [ ] 確認 {script-name} 已部署且可執行（SSH 檢查檔案權限和內容）` |

    **重要**：
    - 每個測項必須具體到可以用指令驗證，不得使用模糊描述
    - 若修改了通知邏輯，測項應包含「確認通知格式正確且有收到」
    - 若修改了 API 端點，測項應包含「確認 API 回應正確」
    - 根據 diff 內容產生更具體的測項，例如「確認 Telegram 通知包含 PR 連結」
    - 每個 PR 至少一個測項，最多不超過 5 個
    - 固定附加：`- [ ] 確認無敏感資訊外洩`
```

- [ ] **Step 3: 更新 Validation Checklist**

將第 232 行的：
```markdown
- [ ] PR body 包含部署注意事項
```

改為：
```markdown
- [ ] PR body 包含部署注意事項和具體 Post-Deploy 驗證項目
```

- [ ] **Step 4: 驗證檔案格式**

讀取修改後的檔案，確認 markdown 結構完整。

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/push-pr/SKILL.md
git commit -m "feat: push-pr skill 改為產生具體 post-deploy 驗證項目"
```

---

### Task 6: Verify-PR Skill

**Files:**
- Create: `.claude/skills/verify-pr/SKILL.md`

- [ ] **Step 1: 建立 skill 目錄和檔案**

```bash
mkdir -p .claude/skills/verify-pr
```

- [ ] **Step 2: 撰寫 SKILL.md**

```markdown
---
name: verify-pr
description: Post-deploy 驗證。輸入 PR 編號（如 #63），AI 根據 PR 中的測項逐一驗證並提供實證。使用者說「/verify-pr #63」、「驗證 PR」時觸發。
---

# Verify PR — Post-Deploy 驗證

根據 PR body 中的 Post-Deploy 驗證項目，逐一執行驗證並提供實證。

## Allowed Tools

Bash, Read, Grep, Glob, AskUserQuestion, `mcp__openclaw-server__ssh_exec`, `mcp__openclaw-server__ssh_read_file`, `mcp__openclaw-server__ssh_list_dir`

## 前置載入

執行此 skill 前，**必須**先載入 `openclaw-map` skill 以了解伺服器檔案結構。

## Argument Parsing

| 輸入 | 行為 |
|------|------|
| `#63` 或 `63` | 驗證指定 PR |
| 無參數 | 提示使用者輸入 PR 編號 |

## Workflow

### Phase 1: 讀取測項

1. 取得 PR 資訊：
   ```bash
   gh pr view {number} --json body,title,state,mergedAt
   ```

2. 從 PR body 擷取 `## Post-Deploy 驗證` 區塊：
   - 若無此區塊，嘗試 `## 測試確認`（舊格式）
   - 若仍無，告知使用者此 PR 無驗證項目

3. 解析每個 `- [ ]` 項目為待驗證清單

### Phase 2: 逐項驗證

對每個測項：

1. **分析測項內容**，判斷驗證方式：

   | 測項類型 | 驗證方式 |
   |----------|----------|
   | 確認檔案已部署 | `mcp__openclaw-server__ssh_read_file` 或 `ssh_exec cat` 比對內容 |
   | 確認 config 已生效 | `ssh_read_file` 讀取遠端 config 並比對關鍵欄位 |
   | 確認 cron job 排程 | `ssh_exec` 執行 `crontab -l` 或讀取 cron-jobs.json |
   | 確認服務運行中 | `ssh_exec` 執行 `systemctl --user status` 或 `pgrep` |
   | 確認通知有發送 | 無法自動驗證，標記為「需人工確認」 |
   | 確認 workflow 可觸發 | `gh workflow list` 或 `gh run list` 檢查 |
   | 確認無敏感資訊外洩 | `gh pr diff {number}` 檢查是否包含 token/key pattern |

2. **執行驗證指令**，收集輸出作為實證

3. **判斷結果**：
   - **通過**：有明確實證支持（指令輸出、檔案內容等）
   - **未通過**：實證顯示不符預期
   - **無法驗證**：無法取得實證（如需人工確認的項目），需說明原因

### Phase 3: 結果處理

#### 全部通過

1. 在 PR 留 comment，格式：

```markdown
## ✅ Post-Deploy 驗證通過

驗證時間: {YYYY-MM-DD HH:mm UTC+8}
驗證者: Claude Code

### 測項結果

- [x] {測項描述}
  ```
  {實證：指令及其輸出}
  ```

- [x] {測項描述}
  ```
  {實證}
  ```
```

2. 更新 label：
   ```bash
   gh pr edit {number} --add-label "verified" --remove-label "deployed" --remove-label "awaiting-verification"
   ```

3. 告知使用者驗證全部通過

#### 有未通過或無法驗證的項目

1. **通過的測項**仍然在 PR 留 comment（同上格式，但標題改為 `## ⚠️ Post-Deploy 部分驗證`）
2. **未通過/無法驗證的測項**輸出給使用者，格式：

```
❌ 以下測項未通過或無法驗證：

1. {測項描述}
   原因: {具體原因，如指令輸出不符預期、SSH 連線失敗等}

2. {測項描述}
   原因: {需人工確認，無法自動驗證}
```

3. 不變更 label，由使用者決定下一步

## 關鍵規則

1. **每個測項必須有實證** — 不可僅憑推測判斷通過
2. **實證必須包含實際指令輸出** — 不可偽造或假設輸出
3. **無法驗證就是未通過** — 寧可報告無法驗證，不可虛報通過
4. **通過記錄寫 PR comment** — 作為 audit trail
5. **未通過記錄輸出給使用者** — 不寫入 PR，避免噪音
6. **使用 openclaw-server MCP** — 透過 `ssh_exec`、`ssh_read_file` 等工具連線驗證
```

- [ ] **Step 3: 驗證檔案格式**

讀取建立的檔案，確認 markdown 結構和 frontmatter 正確。

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/verify-pr/SKILL.md
git commit -m "feat: 新增 verify-pr skill — AI 驅動的 post-deploy 驗證"
```

---

### Task 7: Awaiting-Verification Reminder Workflow

**Files:**
- Create: `.github/workflows/awaiting-verification-reminder.yml`

- [ ] **Step 1: 建立 workflow 檔案**

```yaml
name: Awaiting Verification Reminder

on:
  schedule:
    # UTC 02:05, 06:05, 09:05 weekdays = UTC+8 10:05, 14:05, 17:05
    # Staggered 5min after pr-approved-reminder to avoid Telegram rate limits
    - cron: '5 2,6,9 * * 1-5'
  workflow_dispatch:

permissions:
  pull-requests: read

jobs:
  remind:
    runs-on: ubuntu-latest
    steps:
      - name: Query unverified PRs
        id: query
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          # Find PRs with awaiting-verification label (merged within last 7 days)
          CUTOFF=$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-7d +%Y-%m-%dT%H:%M:%SZ)

          PRS=$(gh pr list --repo "${{ github.repository }}" \
            --state all \
            --label "awaiting-verification" \
            --json number,title,url,mergedAt \
            --jq "[.[] | select(.mergedAt > \"$CUTOFF\")]")

          COUNT=$(echo "$PRS" | jq 'length')
          echo "count=$COUNT" >> "$GITHUB_OUTPUT"

          if [ "$COUNT" -eq 0 ]; then
            echo "No unverified PRs found."
            exit 0
          fi

          # Build Telegram message
          NOW=$(date +%s)
          MSG=$(printf '🔍 <b>待驗證 PR 提醒</b>\n\n')

          echo "$PRS" | jq -c '.[]' | while read -r pr; do
            NUMBER=$(echo "$pr" | jq -r '.number')
            TITLE=$(echo "$pr" | jq -r '.title')
            URL=$(echo "$pr" | jq -r '.url')
            MERGED=$(echo "$pr" | jq -r '.mergedAt')

            # Calculate hours since merge
            MERGED_TS=$(date -d "$MERGED" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%SZ" "$MERGED" +%s 2>/dev/null || echo "$NOW")
            HOURS=$(( (NOW - MERGED_TS) / 3600 ))

            printf '<b>#%s</b> %s\n   🕐 部署後等待 %s 小時\n   🔗 <a href="%s">#%s</a>\n\n' \
              "$NUMBER" "$TITLE" "$HOURS" "$URL" "$NUMBER"
          done > /tmp/reminder_msg.txt

          MSG="${MSG}$(cat /tmp/reminder_msg.txt)"
          MSG="${MSG}💡 使用 <code>/verify-pr #N</code> 進行驗證"

          printf "%s" "$MSG" > /tmp/final_msg.txt
          echo "has_prs=true" >> "$GITHUB_OUTPUT"

      - name: Send Telegram notification
        if: steps.query.outputs.has_prs == 'true'
        env:
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
        run: |
          CHAT_ID="${{ vars.TELEGRAM_REMINDER_CHAT_ID }}"
          MSG=$(cat /tmp/final_msg.txt)

          curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
            -d chat_id="$CHAT_ID" \
            -d parse_mode="HTML" \
            --data-urlencode "text=${MSG}" \
            -o /dev/null -w "Telegram HTTP %{http_code}\n"
```

- [ ] **Step 2: 驗證 YAML 語法**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/awaiting-verification-reminder.yml'))"
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/awaiting-verification-reminder.yml
git commit -m "ci: 新增待驗證 PR 定時 Telegram 提醒（工作日 10/14/17 點）"
```

---

### Task 8: 最終驗證與整合 Commit

- [ ] **Step 1: 確認所有檔案都已 commit**

```bash
git status
git log --oneline -7
```

Expected: 工作區乾淨，有 6 個新 commit（Task 2-7 各一個）。

- [ ] **Step 2: 驗證所有 YAML workflow 語法**

```bash
for f in .github/workflows/pr-label-lifecycle.yml .github/workflows/deploy.yml .github/workflows/awaiting-verification-reminder.yml; do
  echo "Checking $f..."
  python3 -c "import yaml; yaml.safe_load(open('$f'))" && echo "  OK" || echo "  FAIL"
done
```

- [ ] **Step 3: 確認檔案結構完整**

```bash
ls -la .github/workflows/pr-label-lifecycle.yml
ls -la .github/workflows/awaiting-verification-reminder.yml
ls -la .claude/skills/verify-pr/SKILL.md
ls -la .claude/skills/push-pr/SKILL.md
ls -la workspaces/openclaw-coderevie-ol/skills/code-review/SKILL.md
```

- [ ] **Step 4: 使用 push-pr skill 推送 PR**

使用 `/push-pr` 將所有變更推送為 PR，PR body 中的 `## Post-Deploy 驗證` 應使用新格式產生具體測項。
