---
name: verify-pr
description: Post-deploy 驗證。輸入 PR 編號（如 #63），AI 根據 PR 中的測項逐一驗證並提供實證。使用者說「/verify-pr #63」、「驗證 PR」時觸發。
---

# Verify PR — Post-Deploy 驗證

根據 PR body 中的 Post-Deploy 驗證項目，逐一執行驗證並提供實證。

## Allowed Tools

Bash, Read, Grep, Glob, AskUserQuestion, `mcp__openclaw-server__ssh_exec`, `mcp__openclaw-server__ssh_read_file`, `mcp__openclaw-server__ssh_list_dir`

> Bash 工具在本 skill 中用於：(1) gh CLI 操作 (2) `openclaw gateway call` 執行 Skill 行為驗證

## 前置載入

執行此 skill 前，**必須**先載入 `openclaw-server-ops` skill 以了解遠端操作注意事項。建議同時載入 `openclaw-map` 以了解檔案結構。

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

4. 檢查 PR body 是否包含 `<!-- verify-pr:skill-behavior-start -->` 標記：
   - 若有 → 解析 start/end 標記之間的表格，提取每個案例的 agentId、Session、測試發問、原始回應摘要、驗證重點
   - 這些案例將在 Phase 2.5 進行行為驗證

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

### Phase 2.5: Skill 行為驗證

**觸發條件**：Phase 1 步驟 4 有解析到行為驗證案例時執行。若 PR body 無 `<!-- verify-pr:skill-behavior-start -->` 標記，**跳過此 Phase**。

#### Gateway 連線資訊取得

> **重要**：Gateway call 必須透過 `ssh_exec` 在 **server 端**以 localhost 執行，不可從本機直接連遠端 gateway（會被 device pairing 擋住）。

1. SSH 讀取遠端 openclaw.json 取得 gateway token（注意用絕對路徑，SSH MCP 帳號是 `openclaw-reader`）：
   ```bash
   mcp__openclaw-server__ssh_exec: cat /home/hqj/.openclaw/openclaw.json | python3 -c "
   import sys,json
   c=json.load(sys.stdin)
   print(c['gateway']['auth']['token'])
   "
   ```
2. 記下 token 值，後續 gateway call 會用到

#### 驗證流程

對每個測試案例：

1. **讀取 PR diff** 理解本次修正了什麼問題，形成驗證基準

2. **透過 ssh_exec 在 server 端執行 gateway call**：
   ```bash
   mcp__openclaw-server__ssh_exec: OPENCLAW_HOME=/home/openclaw-reader \
     OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1 \
     /usr/bin/openclaw gateway call \
     --url "ws://127.0.0.1:18789" \
     --token "<token>" \
     --json --expect-final --timeout <timeout> \
     --params '{"agentId":"<agentId>","idempotencyKey":"verify-pr<number>-case<index>-<timestamp>","message":"<測試發問>"}' \
     agent
   ```
   - **必須**設定 `OPENCLAW_HOME=/home/openclaw-reader`（openclaw-reader 有自己的已配對 device identity）
   - **必須**連 `ws://127.0.0.1:18789`（localhost），不可用 Tailscale IP
   - timeout 預設 120000（120 秒）
   - 若驗證重點涉及 ELK 查詢等慢操作，延長到 300000（300 秒）
   - `ssh_exec` 的 timeout 參數需設為 gateway call timeout 的秒數 + 10（例如 gateway 120s → ssh_exec timeout 130）

3. **提取 Agent 回應**：從 JSON 回應的 `result.payloads[0].text` 取得

4. **AI 判斷**：
   - 比對「驗證重點」+「原始回應摘要」（before）vs「新回應」（after）
   - 判斷 Agent 是否還犯同樣的錯
   - 判斷結果三種：
     - **pass**：新回應符合修正預期，問題已解決
     - **fail**：新回應仍有相同問題
     - **unable-to-verify**：Agent 回應為環境問題（如「無法存取資料」、連線失敗等），非邏輯問題
   - 產出：判斷結果 + 理由 + 關鍵證據片段

#### 錯誤處理

| 錯誤情境 | 處理方式 |
|----------|----------|
| Gateway WebSocket 連線失敗 | 標記為 unable-to-verify，輸出錯誤訊息 |
| `pairing required` | openclaw-reader 的 device 未配對。需要 hqj 在 server 上執行 `openclaw devices approve` |
| Agent 不存在或未啟動 | 標記為 unable-to-verify |
| Token 過期或無效 | 標記為 unable-to-verify，提示檢查 config |
| 網路中斷 | 標記為 unable-to-verify，輸出錯誤訊息 |
| Gateway call timeout | 標記為 unable-to-verify，建議手動驗證 |

> **注意**：`unable-to-verify` 是環境問題，**不計為 fail**。僅 `fail` 狀態代表 Agent 邏輯未修正。

#### 結果確認

彙整所有案例後，**🔴 Checkpoint — BLOCKING**：呼叫 `AskUserQuestion`：

```
📋 Skill 行為驗證結果：

✅ 案例 1: "{測試發問}"
   判斷: PASS
   理由: {AI 的判斷理由}
   原始回應: "{原始回應摘要}"
   新回應摘要: "{新回應的關鍵片段}"

❌ 案例 2: "{測試發問}"
   判斷: FAIL
   理由: {AI 的判斷理由}
   原始回應: "{原始回應摘要}"
   新回應摘要: "{新回應的關鍵片段}"

請確認以上結果（y 確認 / 修改判斷）：
```

#### idempotencyKey 格式

`verify-pr{number}-case{index}-{timestamp}`

例如：`verify-pr87-case1-1711270800`

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

2. 若有 Skill 行為驗證結果且**全部 pass**（unable-to-verify 不計為 fail），額外留一個**獨立 comment**（與 Post-Deploy 驗證 comment 分開）：
   - 標題：`## ✅ Skill 行為驗證通過`
   - Comment 格式包含：驗證時間、驗證者、案例結果表格、詳細判斷理由
   - 若有 fail → **不寫入 PR comment**，所有結果（含 pass 的案例）僅輸出給使用者，不變更 label
   - 若有 unable-to-verify 但無 fail → 仍視為通過，unable-to-verify 的案例在 comment 中標註為環境問題

3. 更新 label：
   ```bash
   gh pr edit {number} --add-label "verified" --remove-label "deployed" --remove-label "awaiting-verification"
   ```

4. 告知使用者驗證全部通過

#### 有未通過或無法驗證的項目（Post-Deploy 測項）

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

> **Skill 行為驗證的結果不影響 Post-Deploy 測項的判定**，兩者獨立處理。

#### Label 更新規則

label 更新由兩套驗證結果**共同決定**：

| Post-Deploy 測項 | Skill 行為驗證 | label 操作 |
|------------------|---------------|------------|
| 全部通過 | 全部 pass 或無此區塊 | 加 `verified`，移除 `deployed` + `awaiting-verification` |
| 全部通過 | 有 unable-to-verify 但無 fail | 同上（unable-to-verify 不阻擋） |
| 全部通過 | 有 fail | **不更新** label |
| 有未通過 | 任何結果 | **不更新** label |

## 關鍵規則

### Post-Deploy 驗證（Phase 2）
1. **每個測項必須有實證** — 不可僅憑推測判斷通過
2. **實證必須包含實際指令輸出** — 不可偽造或假設輸出
3. **無法驗證就是未通過** — 寧可報告無法驗證，不可虛報通過

### Skill 行為驗證（Phase 2.5）
4. **unable-to-verify ≠ fail** — 環境問題（gateway 連不上等）不代表邏輯有錯，不阻擋通過
5. **fail 才阻擋** — 只有 Agent 回應仍有相同問題時才計為失敗

### 共通規則
6. **通過記錄寫 PR comment** — 作為 audit trail
7. **未通過記錄輸出給使用者** — 不寫入 PR，避免噪音
8. **使用 openclaw-server MCP** — 透過 `ssh_exec`、`ssh_read_file` 等工具連線驗證
