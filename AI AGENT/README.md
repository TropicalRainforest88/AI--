# OpenClaw Operations

OpenClaw 多 agent 運維設定庫。管理 agent 設定、skill、workspace 和部署流程。

## 架構概覽

```
openclaw_op/
├── config/
│   ├── openclaw.json          # 主設定（agent、bindings、channels）
│   └── cron-jobs.json         # 排程任務定義
├── workspaces/
│   ├── cams-cryp-pre/         # PRE 環境 CAMS/CRYP agent workspace
│   │   ├── SOUL.md            # Agent 人設
│   │   └── skills/            # 18 個 skill（服務級隔離）
│   ├── cams-cryp-ol/          # OL 環境 CAMS/CRYP agent workspace
│   │   ├── SOUL.md
│   │   └── skills/            # 18 個 skill
│   ├── onepay/                # OnePay agent workspace（PRE + OL 雙環境）
│   │   ├── SOUL.md            # Agent 人設
│   │   ├── docs/              # 參考文件（architecture, pm-ops-spec, elk-keywords 等）
│   │   └── skills/            # 2 個 skill（onepay-direct-api, onepay-jira）
│   ├── gb-ol/                 # GB OL agent workspace
│   │   └── skills/            # 1 個 skill（elk-log-query）
│   ├── settlement/            # 結算 agent workspace
│   │   └── skills/            # 1 個 skill（settlement-bot）
│   └── openclaw-coderevie-ol/ # 代碼審查 agent workspace
│       └── skills/            # 2 個 skill（code-review, openclaw-map）
├── scripts/
│   ├── deploy.sh              # 部署腳本（支援雙主機 HA 部署）
│   └── setup-standby.sh       # 備援伺服器一次性初始化腳本
├── watchdog/
│   ├── watchdog.sh            # HA 故障切換狀態機
│   ├── openclaw-watchdog.service  # systemd 服務單元
│   ├── openclaw-watchdog.timer    # 30 秒健康檢查計時器
│   └── watchdog.env.example   # watchdog 環境變數範本
└── .claude/skills/             # 開發工作流 skill（push-pr 等）
```

## Agent 設定

| Agent | 環境 | 模型 | Telegram 綁定 |
|-------|------|------|--------------|
| `main` | - | openai/gpt-5.1-codex (預設) | 無（DM only） |
| `cams-cryp-pre` | PRE | openai/gpt-5.3-codex | 1 個群組（`-5147383846`） |
| `cams-cryp-ol` | OL | openai/gpt-5.3-codex | 5 個群組 |
| `onepay` | PRE + OL | openai/gpt-5.4 | 1 個群組（`-5189560927`） |
| `gb-ol` | OL | openai/gpt-5.4 | 無 |
| `openclaw-coderevie-ol` | - | openai/gpt-5.3-codex | 1 個群組（代碼審查） |

### Agent 命名規則

```
格式：{service}-{env}
範例：cams-cryp-pre, cams-cryp-ol, risk-pre, risk-ol
```

> **例外**：`onepay` 不帶環境後綴，單一 agent 透過訊息語境判斷 pre / ol 環境，避免重複維護兩份設定。

### 模型設定

| 項目 | 值 |
|------|-----|
| 預設主模型 | `openai/gpt-5.1-codex` |
| Fallbacks | `openai/gpt-5.3-codex`, `minimax/MiniMax-M2.5` |
| cams-cryp-pre/ol 模型 | `openai/gpt-5.3-codex` |
| onepay 模型 | `openai/gpt-5.4` |
| Auth 方式 | OpenAI API Key + MiniMax Portal OAuth |

## Skill 架構

Skill 按 workspace 隔離，每個 agent 只能存取自己 workspace 內的 skill。

**載入優先順序**（OpenClaw 內建機制）：
1. `<workspace>/skills/` — 最高優先
2. `~/.openclaw/skills/` — 使用者全域
3. `<install>/skills/` — 內建

**目前 cams-cryp 服務共 18 個 skill：**

| 類別 | Skill |
|------|-------|
| CAMS 操作 | cams-balance, cams-deposit, cams-withdraw, cams-swap, cams-merchant, cams-liquidity, cams-fund-flow, cams-notify-alert, cams-risk-address, cams-wallet-transfer |
| CRYP 操作 | cryp-deposit, cryp-withdraw, cryp-notify, cryp-fee-gas, cryp-node-block |
| 跨系統查詢 | cams-cryp-query（PRE/OL 各有環境專屬版本） |
| 規格參考 | cams-specs, cryp-specs |

**目前 onepay 服務共 2 個 skill：**

| Skill | 說明 |
|-------|------|
| `onepay-direct-api` | 充值建單（Direct API）配對提現單、sign 算法、ELK 查詢步驟 |
| `onepay-jira` | Jira 開單整合（故障單、改進單、任務單） |

**目前 gb-ol 服務共 1 個 skill：**

| Skill | 說明 |
|-------|------|
| `elk-log-query` | ELK 日誌查詢（含交易明細餘額比對） |

**目前 settlement 服務共 1 個 skill：**

| Skill | 說明 |
|-------|------|
| `settlement-bot` | 結算訂單查詢（ES 查詢、異常訂單轉發、銀行回單 OCR 辨識） |

**目前 openclaw-coderevie-ol 服務共 2 個 skill：**

| Skill | 說明 |
|-------|------|
| `code-review` | GitHub App 自動代碼審查（四面向審查 + merge/deploy 工作流程） |
| `openclaw-map` | OpenClaw 檔案結構知識參考 |

**新增 skill：** 將 skill 目錄（含 `SKILL.md`）放入對應 workspace 的 `skills/` 下。

### 開發工作流 Skill（`.claude/skills/`）

這些 skill 供 Claude Code 在本地開發時使用，不部署到伺服器。

| Skill | 觸發方式 | 說明 |
|-------|---------|------|
| `push-pr` | `/push-pr` | 建立分支、commit、開 PR，自動產生 Post-Deploy 驗證項目 |
| `verify-pr` | `/verify-pr #N` | 根據 PR 中的驗證項目，SSH 到伺服器逐項驗證並回報結果 |
| `openclaw-review-pr` | 由 codereview agent 使用 | PR 四面向審查（程式碼品質、OpenClaw 規範、安全性、部署一致性）+ merge/deploy 流程 |
| `openclaw-server-ops` | 自動載入 | SSH MCP 操作參考，查詢伺服器狀態、確認部署、存取遠端檔案時使用 |
| `openclaw-map` | 自動載入 | OpenClaw 檔案結構知識參考，協助 AI 定位 config、logs、sessions 等路徑 |

## 部署

### 前置條件

1. 複製 `.env.example` 為 `.env` 並填入實際值
2. 確保在 Tailscale 網路內

### 部署指令

```bash
# 完整部署（config + skills + soul + restart）
./scripts/deploy.sh --all

# 分項部署
./scripts/deploy.sh --config    # 僅部署 openclaw.json
./scripts/deploy.sh --skills    # 僅部署 skill（rsync 到各 workspace）
./scripts/deploy.sh --soul      # 僅部署 SOUL.md
./scripts/deploy.sh --cron      # 僅部署 cron jobs
./scripts/deploy.sh --secrets   # 僅部署密鑰檔案（ELK、Jira token 等）
./scripts/deploy.sh --restart   # 搭配使用，部署後重啟 gateway

# HA 雙主機部署
./scripts/deploy.sh --all --target primary   # 僅部署到主伺服器
./scripts/deploy.sh --all --target standby   # 僅部署到備援伺服器
./scripts/deploy.sh --all --target both      # 部署到兩台（預設）
```

部署流程：本地修改 → 推 PR → merge → 執行 `deploy.sh`（或透過 GitHub Actions 自動部署）

## PR 生命週期

PR 從建立到驗證的完整流程，大部分由 AI + GitHub Actions 自動處理，人類只需在關鍵節點觸發或介入。

### 流程與人類操作點

```
1. 開發完成 → Claude Code 執行 /push-pr
                ↓ (建分支、commit、開 PR)
2. Code Review ← 自動觸發，codereview agent 審查
                ↓
3. 審查結果：
   ├─ ✅ approved → Telegram 會定時提醒待部署
   └─ ❌ need-change → 修改後再推，回到步驟 2
                ↓
4. 告訴 Agent 助理「merge 並部署 PR #N」
                ↓ (merge → 觸發 deploy workflow)
5. 部署完成 → Telegram 收到通知（含健康檢查 + 驗證項目）
                ↓
6. Claude Code 執行 /verify-pr #N
                ↓ (SSH 到伺服器逐項驗證)
7. 驗證通過 → PR 標記 verified，流程結束
```

### 人類操作清單

| 步驟 | 你要做什麼 | 工具 | 說明 |
|------|-----------|------|------|
| 推 PR | 執行 `/push-pr` | Claude Code | 建分支、commit、開 PR，過程中確認分支名和 commit message |
| 看審查結果 | 收到通知或去 GitHub 看 | Telegram / GitHub | 自動審查通常幾分鐘內完成 |
| 處理 need-change | 修改程式碼後再推 PR | Claude Code | 重新觸發 code review |
| 部署 | 說「merge 並部署 PR #N」 | Agent 助理 (Telegram) | merge → 觸發部署，Telegram 通知結果 |
| 驗證 | 執行 `/verify-pr #N` | Claude Code | SSH 逐項驗證，全通過自動更新 label |
| 收到提醒 | 看通知決定是否處理 | Telegram | approved 未部署、deployed 未驗證都會定時提醒 |

### GitHub Actions Workflows

| Workflow | 觸發條件 | 用途 |
|----------|---------|------|
| `pr-label-lifecycle` | PR opened/sync/reopen | 自動加 `review` label |
| `pr-codereview` | PR opened/sync/reopen | 觸發 codereview agent 四面向審查 |
| `pr-approved-reminder` | 工作日 10:00/14:00/17:00 | 提醒已 approved 但未部署的 PR |
| `deploy` | 手動觸發 | 部署 + 建立 deploy tag + 更新 label + Telegram 通知 |
| `awaiting-verification-reminder` | 工作日 10:05/14:05/17:05 | 提醒已部署但未驗證的 PR |

### Label 狀態機

| Label | 含義 | 自動/手動 |
|-------|------|----------|
| `review` | 等待 code review | workflow 自動加 |
| `need-change` | 審查未通過，需修改 | codereview agent 加 |
| `approved` | 審查通過 | codereview agent 加 |
| `deployed` | 已部署到伺服器 | deploy workflow 加 |
| `awaiting-verification` | 等待驗證 | deploy workflow 加 |
| `verified` | 驗證完成 | verify-pr skill 加 |

### 查看部署版本

每次成功部署會自動建立 `deploy-YYYYMMDD-HHMMSS` 格式的 git tag：

```bash
git tag -l 'deploy-*' --sort=-creatordate | head -5
```

### Per-Agent API Key 注入

部署腳本會根據 `AGENT_KEY_MAP` 自動為每個 agent 產生 `auth-profiles.json`，對應的 GitHub Secrets：

| Secret 名稱 | 適用 Agent |
|-------------|-----------|
| `OPENAI_API_KEY_MAIN` | main |
| `OPENAI_API_KEY_CAMS` | cams-cryp-pre, cams-cryp-ol |
| `OPENAI_API_KEY_ONEPAY` | onepay |
| `OPENAI_API_KEY_GB_OL` | gb-ol |
| `OPENAI_API_KEY_CODEREVIE_OL` | openclaw-coderevie-ol |

### Session 重置

部署 skill 或 SOUL.md 後，腳本會自動重置 agent session（保留 JSONL 歷史記錄），避免 agent 使用過時的 skill snapshot。

## 遠端伺服器

### 主伺服器（Primary）

| 項目 | 值 |
|------|-----|
| IP | `100.127.134.23` (Tailscale) |
| 主機名 | `hqj-ubuntu-21` |
| 部署帳號 | `hqj` |
| 查詢帳號 | `openclaw-reader`（唯讀） |
| OS | Ubuntu, Linux 6.8.0 (x64) |
| OpenClaw | 2026.3.13 (npm global) |
| Gateway | `http://100.127.134.23:18789/` |
| Gateway (HTTPS) | `https://hqj-ubuntu-21.tail35514a.ts.net/` |

### 備援伺服器（Standby）

| 項目 | 值 |
|------|-----|
| IP | `100.85.165.67` (Tailscale) |
| 部署帳號 | `hqj` |
| 角色 | 待命（STANDBY），由 watchdog 自動切換 |

## HA 故障切換（Watchdog）

備援伺服器透過 watchdog 狀態機監控主伺服器健康狀態，自動進行故障切換與回切。

### 狀態機

```
STANDBY ──(主機連續 5 分鐘無回應)──→ ACTIVE
ACTIVE  ──(主機恢復且穩定 1.5 分鐘)──→ COOLDOWN
COOLDOWN ──(冷卻 5 分鐘)──→ STANDBY
任意狀態 ──(頻繁切換 ≥3 次/小時)──→ ALERT
```

### 元件

| 元件 | 說明 |
|------|------|
| `watchdog/watchdog.sh` | 故障切換狀態機（健康檢查 + 狀態轉移） |
| `openclaw-watchdog.timer` | systemd timer，每 30 秒觸發一次健康檢查 |
| `openclaw-watchdog.service` | systemd service，執行 watchdog.sh |
| `watchdog.env` | 環境設定（Telegram 通知 token、主機 URL 等） |

### 初始設定

```bash
# 一次性初始化備援伺服器
./scripts/setup-standby.sh
```

### Gateway 管理

```bash
# 透過 systemd
systemctl --user restart openclaw-gateway.service
systemctl --user status openclaw-gateway.service
journalctl --user -u openclaw-gateway.service --no-pager -n 30

# 透過 openclaw CLI
openclaw gateway status|start|stop|restart
openclaw logs --follow
openclaw doctor
```

Gateway 啟動約需 25-30 秒完全就緒。

## Telegram Bot

| 項目 | 值 |
|------|-----|
| Bot | `@camsassistant_bot` |
| DM Policy | `pairing` |
| Group Policy | `allowlist` |
| Streaming | `partial` |

### 群組 Binding 對照

| 群組 ID | 群組名稱 | Agent | 說明 |
|---------|---------|-------|------|
| `-5147383846` | PRE-CAMS_助理 | `cams-cryp-pre` | CAMS/CRYP PRE 環境 |
| `-5259338266` | OL-CAMS_助理 | `cams-cryp-ol` | CAMS/CRYP OL 環境 |
| `-1002097705414` | CRYP_產研測試群 | `cams-cryp-ol` | CAMS/CRYP OL 環境 |
| `-1002325901340` | CAMS | `cams-cryp-ol` | CAMS/CRYP OL 環境 |
| `-1003894595368` | HQCC报告群 | `cams-cryp-ol` | CAMS/CRYP OL 環境 |
| `-5175904159` | CAMS/CRYP_助理工程師 | `cams-cryp-ol` | CAMS/CRYP OL 環境 |
| `-5189560927` | Pre-onepay助理 | `onepay` | OnePay（PRE + OL） |
| `-5190882894` | Oenclaw_OP_代碼審查 | `openclaw-coderevie-ol` | 代碼審查 + 部署通知 |

群組授權透過 `channels.telegram.groups` 設定，每個群組可獨立控制 `enabled`、`requireMention`、`allowFrom`。

## Cron Jobs

| 任務 | 排程 | Agent | 說明 |
|------|------|-------|------|
| Daily Jira Digest | 10:00 UTC+8 | `main` | 彙整 CAMS/CRYP 專案進行中 Jira 票，發送至 DM |
| Daily Agent Digest | 21:00 UTC+8 | `main` | 匯總當日所有 agent 對話記錄，發送至 DM |

## 已知問題與解決方案

### 1. OAuth 憑證存錯位置
**問題**: 用 root 跑 `openclaw configure` 會將憑證存到 `/root/.openclaw/`
**解決**: 複製 auth-profiles.json 到 `~/.openclaw/agents/<agentId>/agent/`

### 2. Gateway 啟動失敗
**問題**: `Gateway start blocked: set gateway.mode=local`
**解決**: `openclaw config set gateway.mode local`

### 3. Dashboard CORS 錯誤
**問題**: `origin not allowed`
**解決**: 在 `gateway.controlUi.allowedOrigins` 加入存取的 URL

### 4. Systemd service 安裝失敗
**問題**: `systemctl is-enabled unavailable`
**解決**: 手動建立 `~/.config/systemd/user/openclaw-gateway.service`
