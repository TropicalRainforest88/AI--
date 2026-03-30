# openclaw-server-ops Skill 設計規格

## 概述

OpenClaw-OP 專案的伺服器操作參考手冊。純資訊載入，不定義 workflow。任何需要與伺服器互動的 skill 前置載入它以避免踩坑。

## 檔案位置

`.claude/skills/openclaw-server-ops/SKILL.md`

## Skill 元資料

```yaml
name: openclaw-server-ops
description: OpenClaw-OP 伺服器操作參考。當需要透過 SSH MCP 查詢伺服器、確認部署狀態、或存取遠端檔案時載入。
```

## 載入方式

- **被動載入**：其他 skill（如 `verify-pr`）在開頭寫「必須先載入 `openclaw-server-ops`」
- **主動觸發**：使用者直接呼叫 skill 以查詢伺服器相關資訊

## 行為模式

純參考文件。載入後只提供資訊（帳號、路徑、注意事項），不定義 workflow，由載入它的 skill 決定怎麼用。

## 內容結構

### 1. 連線資訊

- MCP server 名稱：`openclaw-server`
- 可用工具：`ssh_exec`、`ssh_read_file`、`ssh_list_dir`、`ssh_status`
- 帳號：`openclaw-reader`（唯讀）

**主機**：

| 角色 | IP (Tailscale) | 說明 |
|------|-----------------|------|
| 主機 | `100.127.134.23` | 正式環境，MCP 預設連線目標 |
| 備機 | `100.85.165.67` | Standby，平時不啟動 gateway/cron |

日常查詢只查主機。備機僅在主機異常或需要取檔（如 Sophos 誤刪復原）時使用。

### 2. 路徑查找規則

這是此 skill 最核心的防踩坑內容。

**規則**：禁止猜測遠端路徑。

**原因**：
- SSH MCP 以 `openclaw-reader` 帳號連線，`~` 展開為 `/home/openclaw-reader/`，不是 OpenClaw 實際安裝位置
- 本地 repo 目錄結構（如 `workspaces/`）與遠端部署路徑不同

**正確做法**：
1. 先執行 `find /home -maxdepth 3 -name "openclaw.json" 2>/dev/null` 定位 config
2. 從 config 中讀取目標 agent 的 `workspace` 欄位取得實際路徑
3. 再用實際路徑存取檔案

**已知路徑速查表**（加速用，若路徑失效則回退到上述三步驟）：

| 項目 | 路徑 |
|------|------|
| OpenClaw config | `/home/hqj/.openclaw/openclaw.json` |
| Agent workspace pattern | `/home/hqj/.openclaw/workspace-{agent-id}/` |

### 3. 指令執行注意事項

- 執行 `openclaw` CLI 必須用 `bash -l -c '...'`（login shell），否則 PATH 不完整會報 `missing dist/entry.js`
- `openclaw-reader` 可讀取 `/home/hqj/.openclaw/` 下所有內容，唯一例外是 `secrets/` 目錄（0700 權限，owner 是 hqj）
- 需要 API key 時從本機 `~/.openclaw-local-env` 取得，不透過 SSH
- 主機裝有 Sophos SPL 防毒，曾誤刪 `entry.js`。升級 openclaw 後需確認入口檔案仍存在

### 4. 部署流程

- 正確流程：本地修改 → 推 PR → GitHub Actions `workflow_dispatch` 部署
- 禁止直接 SSH 修改伺服器檔案
- `openclaw-reader` 為唯讀帳號，不可做設定變更或重啟服務

### 5. 常用查詢速查表

| 目的 | 指令 |
|------|------|
| 定位 config | `find /home -maxdepth 3 -name "openclaw.json" 2>/dev/null` |
| 查 agent workspace | `grep workspace /home/hqj/.openclaw/openclaw.json` |
| 服務狀態 | `pgrep -a openclaw` 或 `bash -l -c 'openclaw status'` |
| 最新 log | `cat /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log` |
| Cron jobs | `cat /home/hqj/.openclaw/cron/jobs.json` |
| OpenClaw 診斷 | `bash -l -c 'openclaw doctor'` |
| 確認 entry.js 存在 | `ls -la /usr/lib/node_modules/openclaw/dist/entry.js` |

## 與既有 skill 的關係

- **verify-pr**：前置載入改為「必須先載入 `openclaw-server-ops` 以了解遠端操作注意事項，建議同時載入 `openclaw-map` 以了解檔案結構」
- **openclaw-map**：不修改。openclaw-map 負責通用目錄結構；server-ops 負責遠端操作的陷阱與限制

## 設計決策記錄

| 決策 | 選擇 | 理由 |
|------|------|------|
| 範圍 | 完整伺服器操作手冊 | 避免通用 SSH skill 被其他專案誤觸發 |
| 位置 | `.claude/skills/` (repo 內) | 版控追蹤，協作者可共用 |
| 載入方式 | 被動 + 主動兼具 | skill 存在即自動支援兩種方式 |
| 行為模式 | 純參考文件 | 不與其他 skill 的 workflow 衝突，載入成本低 |
