## 自動化 Skill 行為驗證 — Design Spec

**Status**: Draft
**Date**: 2026-03-24

### Problem

目前 verify-pr 只做靜態的 post-deploy 驗證（檔案是否部署、config 是否生效、cron 是否正確），無法驗證 Skill 修改後 Agent 的**行為**是否符合預期。當 PR 修正了某個 Skill 的 bug，沒有機制能自動重跑過去觸發過該 bug 的真實案例，確認問題確實已被修正。

### Solution

擴充 push-pr 和 verify-pr 兩個 skill，形成「標註案例 → 重跑驗證 → AI 判斷 + 人工確認」的迴歸測試流程：

1. **push-pr**：分析 diff → 從 Agent 歷史 session 篩選相關案例 → 使用者確認 → 寫入 PR body
2. **verify-pr**：讀取案例 → 透過 WebSocket gateway call 發給 Agent 重跑 → AI 判斷是否退步 → 使用者確認結果

### 架構概覽

```
push-pr 時                              verify-pr 時
──────────                              ──────────────
Phase 3.5: 行為測試案例標註              新增驗證類型: Skill 行為驗證

分析 diff                                讀取 PR body「Skill 行為驗證」區塊
  ↓                                       ↓
識別修改的 Skill → 對應 agentId           讀取 PR diff → 理解修正了什麼
  ↓                                       ↓
SSH 讀取 Agent 近 3 天 session JSONL      對每個案例：
  ↓                                         gateway call → Agent
AI 篩選相關案例                               ↓
  （含原始 Agent 回應作為比對基準）          收到回應 → AI 比對新舊回應 + 驗證重點
  ↓                                           ↓
Checkpoint S: 列出案例讓使用者確認         Checkpoint: 使用者確認結果
  ↓                                           ↓
寫入 PR body「Skill 行為驗證」區塊         全部 pass → 寫入 PR comment（獨立區塊）
                                           有 fail → 輸出給使用者
```

---

### push-pr 變更：Phase 3.5 Skill 行為測試案例標註

#### 觸發條件

diff 包含以下路徑的修改時觸發：
- `workspaces/**/skills/**`
- `workspaces/**/SOUL.md`

以下變更**不觸發**（與 Agent 對話行為無關）：
- `config/**`（純設定檔）
- `scripts/**`（部署腳本）
- `.claude/skills/**`（本地開發工具 skill）
- `docs/**`（文件）
- `.github/workflows/**`（CI/CD）

#### 流程

```
1. 從 diff 識別被修改的 Skill 屬於哪個 Agent
   - 路徑規則：workspaces/<agentId>/skills/<skill-name>/
   - agentId 直接從路徑提取（workspaces 目錄名即為 agentId）

2. SSH 讀取該 Agent 近 3 天的 session 檔案
   - 先從 config/openclaw.json 查該 agent 的 agentDir 欄位取得實際路徑
   - session 路徑：<agentDir>/../sessions/*.jsonl
     （agentDir 格式為 ~/.openclaw/agents/<id>/agent，sessions 為同層目錄）
   - 按檔案修改時間篩選近 3 天
   - 若找不到相關案例：
     → AskUserQuestion：「未在近 3 天內找到相關案例，請提供時間範圍或 session ID」

3. AI 篩選相關案例
   - 掃描 session JSONL 中使用者的發問內容
   - 比對 diff 修改的邏輯，找出曾觸發過相關行為的對話
   - 同時提取該案例中 Agent 的原始回應（作為後續比對基準）
   - 產出候選清單：session ID + 發問內容 + 原始回應摘要 + 相關原因

4. SOUL.md 變更的特殊處理
   - SOUL.md 影響 Agent 全局行為，不限定特定 skill 的案例
   - 改為更廣泛地掃描 session，找出能反映被修改行為模式的對話

5. Checkpoint S（新增，位於現有 Checkpoint A 之後、Checkpoint B 之前）
   - 命名為 S（Skill）避免與現有 A/B/C 的字母順序混淆
```

#### Checkpoint S 格式

```
📋 偵測到 Skill 行為變更，以下是建議的迴歸測試案例：

1. session: 479cbddc-21a2-4fb1-a85a-120b8177c088
   發問內容: "查詢 VX-00192 的明細晚刷回問題"
   原始回應: "嘗試重新查詢 ELK...（第 3 次重試）..."
   相關原因: 本次修改了 ELK 查詢的 timeout 處理邏輯

2. session: a3f2e1bc-...
   發問內容: "幫我看一下裝置 SOC-1234 的狀態"
   原始回應: "裝置 SOC-1234 目前狀態為閒置..."
   相關原因: 修改了裝置狀態判斷的條件

請確認、修改或新增測試案例（輸入 y 確認，或修改後回覆）：
```

#### PR Body 新增區塊

確認後寫入 PR body，位於「Post-Deploy 驗證」區塊之前：

```markdown
## Skill 行為驗證
<!-- verify-pr:skill-behavior-start -->

| Agent | Session | 測試發問 | 原始回應摘要 | 驗證重點 |
|-------|---------|----------|-------------|----------|
| gb-ol | 479cbddc... | 查詢 VX-00192 的明細晚刷回問題 | 嘗試重新查詢 ELK...（第 3 次重試） | ELK timeout 不再觸發重試 |
| gb-ol | a3f2e1bc... | 幫我看一下裝置 SOC-1234 的狀態 | 裝置 SOC-1234 目前狀態為閒置 | 裝置狀態判斷條件正確 |

<!-- verify-pr:skill-behavior-end -->
```

使用 start/end 標記確保 parser 能可靠提取表格。

---

### verify-pr 變更：Skill 行為驗證類型

#### 觸發條件

PR body 中存在 `<!-- verify-pr:skill-behavior-start -->` 標記。

#### Gateway 連線資訊取得

```
1. SSH 讀取遠端 ~/.openclaw/openclaw.json（本地 config 的 gateway token 為 placeholder，
   必須從已部署的遠端 config 取得實際值）
2. 解析 gateway 區塊取得 host/port/token
3. 組合 WebSocket URL
```

不在 skill 中硬寫連線資訊。

#### 驗證流程

```
1. 解析 PR body 中的行為驗證表格（start/end 標記之間）
   → 取得 agentId、測試發問、原始回應摘要、驗證重點

2. 讀取 PR diff，理解「這次修了什麼問題」
   → 形成驗證基準：原本的錯誤行為 vs 正確行為

3. 對每個測試案例：

   a. 透過 gateway call 發送測試發問
      OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1 openclaw gateway call \
        --url "ws://<gateway-host>:<port>" \
        --token "<token>" \
        --json --expect-final --timeout 120000 \
        --params '{
          "agentId": "<agentId>",
          "idempotencyKey": "verify-pr<number>-case<index>-<timestamp>",
          "message": "<測試發問>"
        }' \
        agent

   b. 從回應中提取 Agent 的處理結果
      → result.payloads[0].text

   c. AI 判斷 pass/fail
      - 讀取「驗證重點」+ 「原始回應摘要」（before baseline）
      - 比對新回應 vs 原始回應，確認問題是否已修正
      - 若 Agent 回應「無法存取資料」等環境問題，標記為 "unable to verify"
        而非 "fail"（區分環境問題 vs 邏輯問題）
      - 產出：pass/fail/unable-to-verify + 判斷理由 + 關鍵證據片段

4. 彙整所有案例結果

5. Checkpoint（行為驗證結果確認）
```

#### 結果確認 Checkpoint 格式

```
📋 Skill 行為驗證結果：

✅ 案例 1: "查詢 VX-00192 的明細晚刷回問題"
   判斷: PASS
   理由: Agent 在 ELK 查詢 timeout 後直接回報無法取得資料，
         未觸發重試邏輯，符合本次修正預期
   原始回應: "嘗試重新查詢 ELK...（第 3 次重試）..."
   新回應摘要: "ELK 查詢逾時，建議稍後重試或縮小時間範圍..."

❌ 案例 2: "幫我看一下裝置 SOC-1234 的狀態"
   判斷: FAIL
   理由: Agent 仍將 offline 裝置判斷為 idle，
         與 PR 修正的條件邏輯不符
   原始回應: "裝置 SOC-1234 目前狀態為閒置..."
   新回應摘要: "裝置 SOC-1234 目前狀態為閒置..."

請確認以上結果（y 確認 / 修改判斷）：
```

#### 結果處理

沿用現有 verify-pr 邏輯，但行為驗證結果寫入**獨立的 PR comment**：
- **全部 pass**：寫入 PR comment（`## ✅ Skill 行為驗證通過`，含實證），更新 label
- **有 fail**：輸出給使用者，不寫入 PR，不變更 label
- **有 unable-to-verify**：輸出給使用者，說明環境問題，不計為 fail

行為驗證 comment 與 Post-Deploy 驗證 comment 分開，互不干擾。

#### 錯誤處理

| 錯誤情境 | 處理方式 |
|----------|----------|
| Gateway WebSocket 連線失敗（server down） | 標記為 "unable to verify"，輸出錯誤訊息給使用者 |
| Agent 不存在或未啟動 | 同上 |
| Token 過期或無效 | 同上，提示使用者檢查 config |
| 網路中斷 | 同上 |
| Gateway call timeout | 標記為 "unable to verify"，建議手動驗證 |

所有連線錯誤都標記為 "unable to verify" 而非 "fail"，避免誤判。

#### Timeout 策略

- 預設 120 秒
- 若驗證重點涉及 ELK 查詢等慢操作，延長到 300 秒
- timeout 由驗證重點內容推斷

#### idempotencyKey 格式

`verify-pr{number}-case{index}-{timestamp}`

例如：`verify-pr87-case1-1711270800`

確保每次驗證呼叫都是獨立操作。

---

### Session 隔離策略

**預設假設**：gateway call 搭配唯一 `idempotencyKey` 即為獨立操作。

**首次使用時確認**：
1. 發送測試 gateway call
2. 檢查 Agent 的 main session JSONL 是否被寫入
3. 若被寫入（非隔離），記錄到 memory 供後續決策

不實作 cron job fallback，若隔離有問題另行處理。

---

### 變更影響摘要

#### push-pr SKILL.md

| 項目 | 現有 | 新增 |
|------|------|------|
| Phase 數量 | 6 個 | 插入 Phase 3.5 |
| Checkpoint | A/B/C | 新增 S（Skill 行為測試案例確認） |
| PR body 區塊 | 變更摘要、變更檔案、部署注意、Post-Deploy 驗證 | 新增「Skill 行為驗證」（含 start/end 標記） |
| Allowed Tools | 無 SSH | 新增 `mcp__openclaw-server__ssh_exec`、`mcp__openclaw-server__ssh_read_file` |

#### verify-pr SKILL.md

| 項目 | 現有 | 新增 |
|------|------|------|
| 驗證類型 | 6 種（檔案、config、cron、service、workflow、敏感資訊） | 新增第 7 種：Skill 行為驗證 |
| 工具 | SSH MCP + gh CLI + Bash | 利用現有 Bash 執行 gateway call |
| 互動 | 無 checkpoint | 新增行為驗證結果確認 checkpoint |
| Gateway 資訊 | — | 從遠端 SSH 讀取 ~/.openclaw/openclaw.json |
| 判斷結果 | pass/fail | 新增 unable-to-verify（環境問題） |
| PR comment | 與 Post-Deploy 驗證共用 | 行為驗證獨立 comment |

#### 不動的部分

- 現有 Post-Deploy 驗證項目產生邏輯
- 現有 SSH 驗證流程
- Label 狀態機
- push-pr Phase 1/2/3/4/5/6 的現有邏輯
- deploy.yml、pr-label-lifecycle.yml 等 workflow

### Required Tools（新增）

| Tool | 用途 | 使用者 |
|------|------|--------|
| `mcp__openclaw-server__ssh_exec` | 讀取遠端 session JSONL | push-pr |
| `mcp__openclaw-server__ssh_read_file` | 讀取遠端 session JSONL | push-pr |
| Bash（已存在） | 執行 `openclaw gateway call` | verify-pr |

### Non-Goals

- Cron job fallback（不在此次範圍）
- 自動修復失敗的測試案例
- 測試案例的持久化管理（案例庫）
- 跨 Agent 的測試案例共享
- Agent 回應的精確文字比對（用 AI 語意判斷）
