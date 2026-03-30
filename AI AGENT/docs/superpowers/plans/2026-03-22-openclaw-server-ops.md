# openclaw-server-ops Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 `openclaw-server-ops` skill，提供 SSH 遠端操作的參考資訊，避免路徑猜測等常見錯誤。

**Architecture:** 純 SKILL.md 參考文件，無程式碼。內容從設計規格直接轉為 skill 格式。另需修改 verify-pr 的前置載入指引。

**Tech Stack:** Markdown (SKILL.md format)

**Spec:** `docs/superpowers/specs/2026-03-22-openclaw-server-ops-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `.claude/skills/openclaw-server-ops/SKILL.md` | 伺服器操作參考手冊 |
| Modify | `.claude/skills/verify-pr/SKILL.md:14-16` | 更新前置載入指引 |

---

### Task 1: 建立 openclaw-server-ops SKILL.md

**Files:**
- Create: `.claude/skills/openclaw-server-ops/SKILL.md`

- [ ] **Step 1: 建立目錄與 SKILL.md**

```bash
mkdir -p .claude/skills/openclaw-server-ops
```

寫入 `.claude/skills/openclaw-server-ops/SKILL.md`：

```markdown
---
name: openclaw-server-ops
description: OpenClaw-OP 伺服器操作參考。當需要透過 SSH MCP 查詢伺服器、確認部署狀態、或存取遠端檔案時載入。
---

# OpenClaw-OP 伺服器操作參考

純參考文件。載入後提供連線資訊、路徑規則、操作注意事項。不定義 workflow。

## 連線資訊

- MCP server：`openclaw-server`
- 可用工具：`ssh_exec`、`ssh_read_file`、`ssh_list_dir`、`ssh_status`
- 帳號：`openclaw-reader`（唯讀）

### 主機

| 角色 | IP (Tailscale) | 說明 |
|------|-----------------|------|
| 主機 | `100.127.134.23` | 正式環境，MCP 預設連線目標 |
| 備機 | `100.85.165.67` | Standby，平時不啟動 gateway/cron |

日常查詢只查主機。備機僅在主機異常或需要取檔（如 Sophos 誤刪復原）時使用。

## 路徑查找規則（最重要）

**禁止猜測遠端路徑。**

原因：
- SSH MCP 以 `openclaw-reader` 帳號連線，`~` 展開為 `/home/openclaw-reader/`，不是 OpenClaw 實際安裝位置
- 本地 repo 目錄結構（如 `workspaces/`）與遠端部署路徑不同

**正確做法：**
1. `find /home -maxdepth 3 -name "openclaw.json" 2>/dev/null` 定位 config
2. 從 config 讀取目標 agent 的 `workspace` 欄位取得實際路徑
3. 用實際路徑存取檔案

**已知路徑速查表**（加速用，若路徑失效則回退上述三步驟）：

| 項目 | 路徑 |
|------|------|
| OpenClaw config | `/home/hqj/.openclaw/openclaw.json` |
| Agent workspace pattern | `/home/hqj/.openclaw/workspace-{agent-id}/` |

## 指令執行注意事項

- 執行 `openclaw` CLI 必須用 `bash -l -c '...'`（login shell），否則 PATH 不完整會報 `missing dist/entry.js`
- `openclaw-reader` 可讀取 `/home/hqj/.openclaw/` 下所有內容，唯一例外是 `secrets/` 目錄（0700 權限，owner 是 hqj）
- 需要 API key 時從本機 `~/.openclaw-local-env` 取得，不透過 SSH
- 主機裝有 Sophos SPL 防毒，曾誤刪 `entry.js`。升級 openclaw 後需確認入口檔案仍存在

## 部署流程

- 正確流程：本地修改 → 推 PR → GitHub Actions `workflow_dispatch` 部署
- 禁止直接 SSH 修改伺服器檔案
- `openclaw-reader` 為唯讀帳號，不可做設定變更或重啟服務

## 常用查詢速查表

| 目的 | 指令 |
|------|------|
| 定位 config | `find /home -maxdepth 3 -name "openclaw.json" 2>/dev/null` |
| 查 agent workspace | `grep workspace /home/hqj/.openclaw/openclaw.json` |
| 服務狀態 | `pgrep -a openclaw` 或 `bash -l -c 'openclaw status'` |
| 最新 log | `cat /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log` |
| Cron jobs | `cat /home/hqj/.openclaw/cron/jobs.json` |
| OpenClaw 診斷 | `bash -l -c 'openclaw doctor'` |
| 確認 entry.js 存在 | `ls -la /usr/lib/node_modules/openclaw/dist/entry.js` |
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/openclaw-server-ops/SKILL.md
git commit -m "feat: 新增 openclaw-server-ops skill — 伺服器操作參考手冊"
```

---

### Task 2: 更新 verify-pr 前置載入

**Files:**
- Modify: `.claude/skills/verify-pr/SKILL.md:14-16`

- [ ] **Step 1: 修改前置載入區段**

將：
```markdown
## 前置載入

執行此 skill 前，**必須**先載入 `openclaw-map` skill 以了解伺服器檔案結構。
```

改為：
```markdown
## 前置載入

執行此 skill 前，**必須**先載入 `openclaw-server-ops` skill 以了解遠端操作注意事項。建議同時載入 `openclaw-map` 以了解檔案結構。
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/verify-pr/SKILL.md
git commit -m "fix: verify-pr 前置載入改為 openclaw-server-ops"
```
