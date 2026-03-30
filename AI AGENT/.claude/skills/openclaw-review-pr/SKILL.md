---
name: openclaw-review-pr
description: Automated PR code review for sitruc-workshop/openclaw_op repo. Authenticates via GitHub App (openclaw-reviewer), reads PR diffs, performs four-dimension review (code quality, OpenClaw conventions, security, deployment consistency), posts structured comments, and manages approve/merge/deploy workflows.
---

# Code Review

Automated code review for the openclaw_op repository via GitHub App API.

## GitHub App Authentication

**App ID**: `3112917`
**Private Key Path**: `/home/hqj/.openclaw/secrets/github-app.pem`

### Step 1: Generate JWT

```bash
# Generate JWT for GitHub App authentication
HEADER=$(echo -n '{"alg":"RS256","typ":"JWT"}' | base64 | tr -d '=' | tr '/+' '_-' | tr -d '\n')
NOW=$(date +%s)
IAT=$((NOW - 60))
EXP=$((NOW + 600))
PAYLOAD=$(echo -n "{\"iat\":${IAT},\"exp\":${EXP},\"iss\":\"3112917\"}" | base64 | tr -d '=' | tr '/+' '_-' | tr -d '\n')
SIGNATURE=$(echo -n "${HEADER}.${PAYLOAD}" | openssl dgst -sha256 -sign /home/hqj/.openclaw/secrets/github-app.pem | base64 | tr -d '=' | tr '/+' '_-' | tr -d '\n')
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

Filter: look for comments where `user.login` is exactly `openclaw-reviewer-op[bot]`. Do NOT use `user.type == "Bot"` as this would match other bots (Renovate, Codex, etc.) and cause missed reviews.

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

### 9. Trigger Deploy Workflow

```bash
curl -s -X POST \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/sitruc-workshop/openclaw_op/actions/workflows/deploy.yml/dispatches" \
  -d '{"ref": "main", "inputs": {"target": "all"}}'
```

### 10. Check Workflow Run Status

```bash
# Get latest workflow run
curl -s \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/sitruc-workshop/openclaw_op/actions/runs?event=workflow_dispatch&per_page=1"
```

Response field: `.workflow_runs[0].status` (queued/in_progress/completed) and `.workflow_runs[0].conclusion` (success/failure/cancelled).

### 11. Get File Content (for Deep Review)

```bash
curl -s \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/sitruc-workshop/openclaw_op/contents/{path}?ref={branch}"
```

Response: base64-encoded content in `.content` field. Decode with `echo "<content>" | base64 -d`.

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

**Approve 後自動 Merge**：PR 被 approve 後，GitHub Actions `auto-merge-approved.yml` 會自動執行 merge。Review agent **不需要**詢問使用者是否 merge，也不需要手動執行 merge API。

流程：
1. Code review agent 完成 review → submit APPROVE → 更新 labels
2. `auto-merge-approved.yml` 偵測到 approve event → 自動 merge PR
3. Merge 到 main 後 → `deploy.yml` 自動觸發部署
4. 部署完成 → Telegram 通知

### 手動 Merge（例外情況）

僅在自動 merge 失敗時才需要手動操作。**每個步驟必須是獨立的 exec 呼叫** — 絕對不要把多個 API 操作合併成一個 command。

#### Merge 安全規則

- **一次只能 merge 一個 PR**，不接受「全部 merge」的指令
- **使用者未指明 PR 編號時，必須追問**：列出候選 PR 讓使用者明確選擇，禁止自行推斷
- **執行 merge 前必須再次確認 PR 編號與標題**，確保使用者知道即將 merge 的是哪個 PR

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

**重要：必須在 inputs 中傳入 `pr_number`**，deploy.yml 會在部署完成後自動發送 Telegram 通知（含健康檢查結果）。

```bash
TOKEN=$(cat /tmp/cr_token.txt)
curl -s -X POST \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/sitruc-workshop/openclaw_op/actions/workflows/deploy.yml/dispatches" \
  -d '{"ref": "main", "inputs": {"target": "all", "pr_number": "{number}"}}'
```

觸發後，告知使用者「已觸發部署，請耐心等候部署結果」即可。**不需要輪詢部署狀態** — 部署過程會重啟 gateway，輪詢會因 SIGTERM 中斷。

### 關鍵規則

1. **Approve 後不需詢問是否 merge** — 自動 merge workflow 會處理
2. **絕對不要把 merge + deploy 合併成一個 exec** — 這會導致 timeout
3. **不要輪詢部署狀態** — deploy.yml 會自動通知結果到 Telegram 群組
4. 任何步驟失敗時，立即回報失敗原因，不要繼續執行後續步驟
