---
name: code-review
description: Automated PR code review for sitruc-workshop/openclaw_op repo. Authenticates via GitHub App (openclaw-reviewer), reads PR diffs, performs four-dimension review (code quality, OpenClaw conventions, security, deployment consistency) plus PR format compliance check, posts structured comments, and manages approve/merge/deploy workflows.
---

# Code Review

Automated code review for the openclaw_op repository via GitHub App API.

## GitHub App Authentication

**App ID**: `3112917`
**Private Key Path**: `__GITHUB_APP_KEY_PATH__`

### Step 1: Generate JWT

```bash
# Generate JWT for GitHub App authentication
HEADER=$(echo -n '{"alg":"RS256","typ":"JWT"}' | base64 | tr -d '=' | tr '/+' '_-' | tr -d '\n')
NOW=$(date +%s)
IAT=$((NOW - 60))
EXP=$((NOW + 600))
PAYLOAD=$(echo -n "{\"iat\":${IAT},\"exp\":${EXP},\"iss\":\"3112917\"}" | base64 | tr -d '=' | tr '/+' '_-' | tr -d '\n')
SIGNATURE=$(echo -n "${HEADER}.${PAYLOAD}" | openssl dgst -sha256 -sign __GITHUB_APP_KEY_PATH__ | base64 | tr -d '=' | tr '/+' '_-' | tr -d '\n')
JWT="${HEADER}.${PAYLOAD}.${SIGNATURE}"
```

### Step 2: Get Installation Token

```bash
# Get installation ID for this specific repo (safe even if App is installed on multiple repos/orgs)
INSTALLATION_ID=$(curl -s \
  -H "Authorization: Bearer ${JWT}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/sitruc-workshop/openclaw_op/installation" | jq '.id')

# Get installation access token
TOKEN=$(curl -s -X POST \
  -H "Authorization: Bearer ${JWT}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens" | jq -r '.token')
```

**Important**: Installation token expires after 1 hour. Always generate a fresh token at the start of each review cycle.

## GitHub API Operations

All API calls use the installation token obtained above.

### 1. List Open PRs

```bash
curl -s \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/sitruc-workshop/openclaw_op/pulls?state=open&per_page=100"
```

### 2. Get PR Files (Diff)

```bash
curl -s \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/sitruc-workshop/openclaw_op/pulls/{number}/files?per_page=100"
```

### 3. Get PR Comments (Check if Already Reviewed)

```bash
# Check issue comments for bot
curl -s \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/sitruc-workshop/openclaw_op/issues/{number}/comments?per_page=100"
```

Filter: look for comments where `user.login` is exactly `openclaw-reviewer[bot]`. Do NOT use `user.type == "Bot"` as this would match other bots (Renovate, Codex, etc.) and cause missed reviews.

### 4. Get PR Reviews

```bash
curl -s \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/sitruc-workshop/openclaw_op/pulls/{number}/reviews"
```

### 5. Post PR Comment

```bash
curl -s -X POST \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/sitruc-workshop/openclaw_op/issues/{number}/comments" \
  -d '{"body": "<REVIEW_CONTENT>"}'
```

### 6. Submit PR Review (Approve / Request Changes)

```bash
# Approve
curl -s -X POST \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/sitruc-workshop/openclaw_op/pulls/{number}/reviews" \
  -d '{"event": "APPROVE", "body": "✅ Code review passed. All four dimensions verified."}'

# Request Changes
curl -s -X POST \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/sitruc-workshop/openclaw_op/pulls/{number}/reviews" \
  -d '{"event": "REQUEST_CHANGES", "body": "<REVIEW_SUMMARY>"}'
```

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

### 8. Merge PR

```bash
curl -s -X PUT \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/sitruc-workshop/openclaw_op/pulls/{number}/merge" \
  -d '{"merge_method": "merge"}'
```

### 9. Get File Content (for Deep Review)

```bash
curl -s \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/sitruc-workshop/openclaw_op/contents/{path}?ref={branch}"
```

Response: base64-encoded content in `.content` field. Decode with `echo "<content>" | base64 -d`.

## PR 格式合規檢查

Review 時必須檢查 PR 是否符合團隊的 push-pr skill 規範。此檢查用於發現未正確使用 skill 的協作者。

### 檢查項目

#### 1. PR Body 結構

PR body 必須包含以下 section（用 `##` heading 判斷）：

| 必要 Section | 說明 |
|-------------|------|
| `## 變更摘要` | 變更內容的 bullet point 列表 |
| `## 變更檔案` | 包含類別、檔案、狀態的表格 |
| `## 部署注意事項` | 部署目標與是否需要 restart |
| `## Post-Deploy 驗證` | 具體可驗證的測項 checkbox |

**判定邏輯**：
- 4 個 section 都有 → ✅ 通過
- 缺少任一 section → ⚠️ 警告，列出缺少的 section

#### 2. Post-Deploy 驗證項目品質

檢查 `## Post-Deploy 驗證` section 內的 checkbox（`- [ ]`）：

- **數量**：至少 1 個，最多 5 個
- **具體性**：每個測項必須包含可執行的驗證方式（如 SSH、API call、crontab -l 等），不得使用模糊描述如「確認功能正常」
- **固定項**：最後一項應為「確認無敏感資訊外洩」

**判定邏輯**：
- 完全缺少 → ❌ 嚴重，此 PR 無法追蹤部署驗證
- 有但全部是模糊描述 → ⚠️ 警告，建議補充具體驗證指令
- 符合規範 → ✅ 通過

#### 3. Commit Message 格式

檢查 PR 的 commit messages（透過 PR API 的 commits endpoint）：

```bash
curl -s \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/sitruc-workshop/openclaw_op/pulls/{number}/commits"
```

**規範**：
- 格式：`{type}: {繁體中文或英文描述}`
- 合法 type：`feat`、`update`、`fix`、`chore`、`ci`、`docs`、`refactor`、`test`
- Regex：`^(feat|update|fix|chore|ci|docs|refactor|test): .+`

**判定邏輯**：
- 所有 commit 符合格式 → ✅ 通過
- 部分不符合 → ⚠️ 警告，列出不符合的 commit message
- merge commit（`Merge branch/pull`開頭）可忽略

#### 4. 敏感檔案

檢查 PR files 列表中是否包含不應 commit 的檔案：

- `.env`（完全符合，不含 `.env.example`）
- `*.pem`、`*.key`
- `auth-profiles.json`
- `credentials.json`

**判定邏輯**：
- 發現敏感檔案 → ❌ 嚴重，必須 Request Changes
- 無 → ✅ 通過

### Review Comment 輸出格式

在 review comment 中新增一個 section，放在現有 review 維度之後：

```markdown
### 📋 PR 格式合規

| 項目 | 結果 | 說明 |
|------|------|------|
| PR Body 結構 | ✅/⚠️/❌ | {具體說明} |
| Post-Deploy 驗證 | ✅/⚠️/❌ | {具體說明} |
| Commit Message | ✅/⚠️/❌ | {具體說明} |
| 敏感檔案 | ✅/❌ | {具體說明} |
```

### 對 Approve/Request Changes 的影響

PR 格式合規是 Approve 的必要條件。未遵循 push-pr skill 規範的 PR 一律 Request Changes。

- **任何 ❌ 項目** → 強制 Request Changes，不可 Approve
- **任何 ⚠️ 項目** → 強制 Request Changes，並在 comment 中具體說明缺失與修正方式
- **全部 ✅** → 格式合規通過，搭配四維度 review 結果決定最終 Approve/Request Changes

Request Changes 時應在 comment 中附上修正指引，例如：「建議使用 push-pr skill 重新建立 PR，或手動補齊缺少的 section」。

## OpenClaw Convention Checklist

When reviewing PRs, check the following OpenClaw-specific conventions:

### Agent Registration
- [ ] New agent added to `config/openclaw.json` → `agents.list` with all required fields (id, name, workspace, agentDir, model)
- [ ] Model registered in `agents.defaults.models` if new
- [ ] Telegram binding added to `bindings` array if agent needs group access
- [ ] Group config added to `channels.telegram.groups` if new group

### Workspace Structure
- [ ] `workspaces/{agent-id}/SOUL.md` exists
- [ ] SOUL.md contains: language setting, tool invocation method, available tools list
- [ ] `workspaces/{agent-id}/skills/{skill-name}/SKILL.md` exists
- [ ] SKILL.md contains: frontmatter (name, description), tool call templates

### Deployment Pipeline
- [ ] `scripts/deploy.sh` → skills loop includes new workspace name
- [ ] `scripts/deploy.sh` → SOUL.md deploy section includes new workspace
- [ ] `scripts/deploy.sh` → mkdir includes new workspace path
- [ ] Secret placeholders (`__XXX__`) have corresponding sed replacement in deploy.sh
- [ ] `.env.example` includes new environment variables
- [ ] `.github/workflows/deploy.yml` → "Create .env" step includes new env vars
- [ ] `.github/workflows/deploy.yml` → env block includes new secret references

### Security
- [ ] No hardcoded tokens, passwords, or API keys in committed files
- [ ] Sensitive values use `__PLACEHOLDER__` pattern for deploy-time injection
- [ ] `.gitignore` excludes `.env` and other secret files
- [ ] No command injection risks (user input not directly concatenated to shell commands)

### Cron Jobs
- [ ] `config/cron-jobs.json` → job agentId matches an existing agent in config
- [ ] Cron expression is valid 5-field format
- [ ] Timezone specified if schedule is time-sensitive
- [ ] Delivery target (Telegram user/group) is valid

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Hardcoded token in SKILL.md | Use `__PLACEHOLDER__` + deploy.sh sed injection |
| New agent not in deploy.sh loop | Add to `for ws in ...` list |
| New secret not in deploy.yml | Add to both echo and env sections |
| Missing model registration | Add to `agents.defaults.models` |
| SOUL.md missing tool call method | Add "工具調用方式" section explaining curl usage |

## Merge & Deploy 工作流程

**Approve 後自動 Merge & Deploy**：PR 被 approve 後，GitHub Actions `auto-merge-approved.yml` 會自動執行 merge 並觸發部署。Review agent **不需要**詢問使用者是否 merge，也不需要手動執行 merge 或 deploy API。

流程：
1. Code review agent 完成 review → submit APPROVE → 更新 labels
2. `auto-merge-approved.yml` 偵測到 approve event → 自動 merge PR
3. 同一 workflow 透過 `workflow_dispatch` 觸發 `deploy.yml`（因 GITHUB_TOKEN merge 不觸發 push event）
4. 部署完成 → Telegram 通知

### 手動 Merge（例外情況）

僅在自動 merge 失敗時才需要手動操作。**每個步驟必須是獨立的 exec 呼叫**。

#### 步驟一：認證

產生 JWT 並取得 installation token（參考上方 GitHub App Authentication）。將 token 存到暫存檔：

```bash
echo "$TOKEN" > /tmp/cr_token.txt
```

#### 步驟二：Merge PR

```bash
TOKEN=$(cat /tmp/cr_token.txt)
RESULT=$(curl -s -X PUT \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/sitruc-workshop/openclaw_op/pulls/{number}/merge" \
  -d '{"merge_method": "merge"}')
echo "$RESULT" | jq '{merged: .merged, message: .message}'
```

如果 merge 失敗，立即回報錯誤給使用者並停止。

#### 步驟三：觸發部署

```bash
TOKEN=$(cat /tmp/cr_token.txt)
curl -s -X POST \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/sitruc-workshop/openclaw_op/actions/workflows/deploy.yml/dispatches" \
  -d '{"ref": "main", "inputs": {"target": "all", "pr_number": "{number}"}}'
```

### 關鍵規則

1. **Approve 後不需詢問是否 merge** — 自動 merge workflow 會處理
2. **絕對不要把 merge + deploy 合併成一個 exec** — 這會導致 timeout
3. 任何步驟失敗時，立即回報失敗原因，不要繼續執行後續步驟
