---
name: push-pr
description: 建立分支、commit 變更並推送 PR，可選擇啟動 PR 狀態監控（merge 後自動驗證、changes requested 自動修復）。當使用者說「推 PR」、「開 PR」、「push pr」、「create pr」時觸發
---

# Push PR Workflow

## Allowed Tools

Bash, Read, Grep, Glob, AskUserQuestion, `mcp__openclaw-server__ssh_exec`, `mcp__openclaw-server__ssh_read_file`

> `ssh_exec` 和 `ssh_read_file` 僅在 Phase 3.5（Skill 行為測試案例標註）使用，用於讀取遠端 Agent session JSONL。

建立分支、提交變更、推送並建立 Pull Request。

## ⛔ 互動確認規則（MANDATORY）

本 workflow 有多個確認點（Checkpoint），每個確認點**必須使用 `AskUserQuestion` 工具**等待使用者回應後才能繼續。

**絕對禁止的行為**：
- ❌ 在文字輸出中問問題然後繼續執行下一步
- ❌ 把確認問題寫在訊息裡，同時呼叫其他工具
- ❌ 假設使用者會同意，跳過確認直接執行
- ❌ 把多個確認點合併成一個問題

**正確的模式**：
1. 準備好要確認的內容（分支名稱、檔案清單、commit message）
2. 呼叫 `AskUserQuestion` 工具，在 `question` 參數中清楚呈現選項
3. **停止**，不做任何其他動作，等待使用者回應
4. 收到回應後，根據回應決定下一步

**確認點清單**（每個都是 BLOCKING，必須等回應）：
- **Checkpoint A**：分支名稱確認（Phase 2, Step 5）
- **Checkpoint S**：Skill 行為測試案例確認（Phase 3.5, Step 8.5）— 僅在 diff 包含 `workspaces/**/skills/**` 或 `workspaces/**/SOUL.md` 時觸發
- **Checkpoint B**：要 commit 的檔案確認（Phase 4, Step 9）
- **Checkpoint C**：Commit message 確認（Phase 4, Step 10）
- **Checkpoint D**：是否啟動 PR 監控（Phase 6, Step 16）

## Argument Parsing

根據 `<command-args>` 決定執行模式：

| 輸入 | 行為 |
|------|------|
| 無參數 | 自動偵測變更 + 互動確認 |
| `--draft` | 建立 draft PR |
| `--no-push` | 只 commit，不推送也不建 PR |
| `--branch <name>` | 指定分支名稱，跳過分支命名步驟 |
| `--title <title>` | 指定 PR 標題，跳過標題產生步驟 |
| `--no-monitor` | 跳過 PR 監控（不問 Checkpoint D，直接結束） |
| `--monitor` | 自動啟動 PR 監控（跳過 Checkpoint D 確認） |

## 敏感檔案保護

以下檔案 **永遠不得** commit：

- `.env`（含密碼與 token）
- 任何 `*.pem`、`*.key` 檔案
- `auth-profiles.json`

若偵測到這些檔案在變更中，**立即警告使用者並從 staging 移除**。

## Workflow

### Phase 1: Pre-flight Check

**目標**：確認環境就緒。

1. **確認工具可用**:
   ```bash
   gh auth status          # 確認 gh CLI 已登入
   git remote -v           # 確認有 origin remote
   ```
   - `gh` 未登入 → 停止，提示 `gh auth login`
   - 無 remote → 停止，提示設定 remote

2. **確認有變更可提交**:
   ```bash
   git status --porcelain  # 檢查工作區狀態
   git diff --cached --stat # 檢查 staged 變更
   ```
   - 若無任何變更（staged + unstaged + untracked 皆為空）→ 停止，提示「沒有變更可提交」
   - 若只有 staged 變更 → 直接使用，不額外 stage

3. **敏感檔案檢查**:
   - 掃描所有變更檔案，比對敏感檔案清單
   - 若發現 `.env` 或其他敏感檔案 → 警告並自動排除
   - 確認 `.gitignore` 包含 `.env`

### Phase 2: Branch Management

4. **判斷當前分支**:
   ```bash
   git branch --show-current
   ```

4.5. **確保分支與 main 同步**：
   ```bash
   git fetch origin main
   git log HEAD..origin/main --oneline
   ```
   - 若 `origin/main` 有新的 commits（輸出非空）→ 執行 `git rebase origin/main`
   - rebase 成功 → 繼續
   - rebase 衝突 → 停止，告知使用者需手動解決衝突後重新執行
   - 若已是最新 → 跳過

5. **分支處理邏輯**:

   **若已在 feature branch（非 main/master）**：
   - 直接使用當前分支，不建新分支
   - 顯示分支名稱讓使用者確認

   **若在 main/master**：
   - 若 `<command-args>` 有 `--branch <name>` → 使用指定名稱
   - 否則根據變更內容自動產生分支名稱，規則如下：

   **分支命名規則**：
   | 變更範圍 | 格式 | 範例 |
   |---------|------|------|
   | 單一 skill | `feat/update-{skill-name}` | `feat/update-cams-deposit` |
   | 多個 skills | `feat/update-skills` | `feat/update-skills` |
   | config 變更 | `chore/update-config` | `chore/update-config` |
   | SOUL.md 變更 | `feat/update-soul-{workspace}` | `feat/update-soul-cams-pre` |
   | 混合變更 | `feat/{簡述}` | `feat/update-deposit-and-config` |
   | workflow 變更 | `ci/update-deploy` | `ci/update-deploy` |
   | 新增 skill | `feat/add-{skill-name}` | `feat/add-cams-balance` |

   - **🔴 Checkpoint A — BLOCKING**：呼叫 `AskUserQuestion` 工具顯示建議的分支名稱，等使用者確認或修改。收到回應前**禁止執行任何 git 指令**。
   - 建立並切換到新分支：
   ```bash
   git checkout -b {branch-name}
   ```

### Phase 3: Change Analysis

6. **分析變更內容**:
   ```bash
   git status --porcelain
   git diff --stat
   git diff --cached --stat
   ```

7. **變更分類**：
   將檔案變更分為以下類別：

   | 類別 | 路徑 pattern | 圖示 |
   |------|-------------|------|
   | Skills | `workspaces/**/skills/**`, `.claude/skills/**` | :wrench: |
   | Config | `config/**` | :gear: |
   | SOUL | `workspaces/**/SOUL.md` | :brain: |
   | Deploy | `.github/**`, `scripts/**` | :rocket: |
   | Docs | `README.md`, `ai.knowledge/**` | :books: |
   | Other | 其他 | :file_folder: |

8. **判斷部署影響**：
   - 修改 `config/openclaw.json` 中的 `gateway` 區塊 → 需要 `--restart`
   - 修改 `config/openclaw.json` 中的其他區塊（如 `agents`、`meta`、`telegramGroups`）→ 僅需一般部署，不需 restart
   - 修改 `config/cron-jobs.json` → 需要 `--cron` 部署
   - 修改 `workspaces/**/skills/**` → 需要 `--skills` 部署
   - 修改 `.claude/skills/**` → 純開發工具，無需部署
   - 修改 `workspaces/**/SOUL.md` → 需要 `--soul` 部署
   - 修改 `scripts/**` 或 `.github/**` → 僅 CI/CD 變更，無需額外部署

### Phase 3.5: Skill 行為測試案例標註

**觸發條件**：Phase 3 分析結果中包含 `workspaces/**/skills/**` 或 `workspaces/**/SOUL.md` 的修改。若 diff 僅涉及 config、scripts、.claude/skills、docs、.github/workflows 等路徑，**跳過此 Phase**。

8.5. **識別 Agent 與掃描歷史 Session**：

    **Step A — 識別 agentId**：
    從修改的檔案路徑直接提取 agentId：
    - 路徑 `workspaces/<agentId>/skills/<skill-name>/` → agentId 即目錄名
    - 路徑 `workspaces/<agentId>/SOUL.md` → 同上

    **Step B — 取得 session 路徑**：
    讀取本地 `config/openclaw.json`，在 `agents.list` 中找到對應 agent 的 `agentDir` 欄位。
    session 路徑為 `agentDir` 的上層目錄下的 `sessions/`：
    - 例：`agentDir` = `/home/hqj/.openclaw/agents/gb-ol/agent`
    - session 路徑 = `/home/hqj/.openclaw/agents/gb-ol/sessions/`

    **Step C — SSH 讀取近 3 天 session JSONL**：
    ```bash
    mcp__openclaw-server__ssh_exec: find <session-path> -name "*.jsonl" -mtime -3
    ```
    對每個 session 檔案，用 `ssh_exec` 讀取內容（或用 `ssh_read_file`），掃描其中使用者的發問訊息。

    **Step D — AI 篩選相關案例**：
    比對 diff 修改的邏輯與 session 中的對話內容：
    - 找出曾觸發過相關行為的對話
    - 同時提取該案例中 Agent 的原始回應（作為比對基準）
    - 若為 SOUL.md 變更：不限定特定 skill，廣泛掃描能反映被修改行為模式的對話

    **Step E — 若找不到相關案例**：
    呼叫 `AskUserQuestion`：「未在近 3 天內找到與本次修改相關的案例，請提供時間範圍或具體 session ID」

    **🔴 Checkpoint S — BLOCKING**：呼叫 `AskUserQuestion` 工具，格式：

    ```
    📋 偵測到 Skill 行為變更，以下是建議的迴歸測試案例：

    1. session: {session-id}
       發問內容: "{使用者的原始問題}"
       原始回應: "{Agent 當時的回應摘要}"
       相關原因: {為什麼這個案例跟本次修改相關}

    2. session: {session-id}
       ...

    請確認、修改或新增測試案例（輸入 y 確認，或修改後回覆）：
    ```

    收到回應前**禁止執行任何後續步驟**。

### Phase 4: Commit

9. **Stage 檔案**：
   - 列出所有變更檔案（排除敏感檔案）
   - **🔴 Checkpoint B — BLOCKING**：呼叫 `AskUserQuestion` 工具列出檔案清單，等使用者確認要 commit 哪些。收到回應前**禁止執行 git add**。
   - 執行 `git add` stage 確認的檔案
   - **不使用 `git add -A` 或 `git add .`**，逐一指定檔案

10. **產生 Commit Message**：

    根據變更分類產生繁體中文 commit message：

    **格式**：`{type}: {繁體中文描述}`

    **Type 判斷**：
    | 變更性質 | type |
    |---------|------|
    | 新增 skill | `feat` |
    | 更新 skill 內容 | `update` |
    | 修改 config | `chore` |
    | 更新 SOUL.md | `feat` |
    | 修改部署腳本 | `ci` |
    | 修改文件 | `docs` |
    | 混合變更 | 以主要變更為主 |

    **範例**：
    ```
    feat: 新增 cams-balance 充值餘額查詢 skill
    update: 更新 cams-deposit 診斷流程，新增風險地址處理步驟
    chore: 調整 openclaw.json gateway 設定
    ci: 更新部署腳本支援 soul 獨立部署
    ```

    - **🔴 Checkpoint C — BLOCKING**：呼叫 `AskUserQuestion` 工具顯示建議的 commit message，等使用者確認或修改。收到回應前**禁止執行 git commit**。
    - 建立 commit：
    ```bash
    git commit -m "{message}"
    ```

11. **若 `--no-push`** → 顯示 commit 摘要後結束

### Phase 5: Push & Create PR

12. **Push 到 remote**：
    ```bash
    git push -u origin {branch-name}
    ```

13. **產生 PR 內容**：

    **PR Title**：與 commit message 相同（或使用 `--title` 指定的標題）

    **PR Body 模板**（繁體中文）：

    ```markdown
    ## 變更摘要
    {依變更分類列出 bullet points}

    ## 變更檔案
    | 類別 | 檔案 | 狀態 |
    |------|------|------|
    | {類別} | `{path}` | 新增/修改/刪除 |

    ## 部署注意事項
    合併後請透過 [GitHub Actions](../../actions/workflows/deploy.yml) 手動觸發部署：
    - 部署目標：`{判斷的 target: all/config/skills/soul}`
    - {若需要 restart} 需要重啟 Gateway（config 有變更）

    {若 Phase 3.5 有執行（diff 包含 Skill/SOUL 變更）：}
    ## Skill 行為驗證
    <!-- verify-pr:skill-behavior-start -->

    | Agent | Session | 測試發問 | 原始回應摘要 | 驗證重點 |
    |-------|---------|----------|-------------|----------|
    | {agentId} | {session-id} | {發問內容} | {原始回應摘要} | {根據 diff 推導的驗證重點} |

    <!-- verify-pr:skill-behavior-end -->

    ## Post-Deploy 驗證
    {根據下方「Post-Deploy 驗證項目產生規則」產生具體驗證項目}
    ```

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
    | `.claude/skills/**` | 見下方「開發工具類變更驗證規則」 |

    **開發工具類變更驗證規則**（`.claude/skills/**`、`docs/**` 等無需伺服器部署的變更）：

    即使不需要伺服器部署，仍然必須產生**行為驗證**測項。驗證重點是「變更是否在實際使用時產生預期效果」：

    | 變更內容 | 驗證項目範例 |
    |----------|-------------|
    | Skill workflow 流程變更 | `- [ ] 實際執行該 skill，確認新流程按預期運作（例：確認每個 Checkpoint 都有觸發 AskUserQuestion 互動）` |
    | Skill 新增功能 | `- [ ] 實際觸發新功能，確認輸出/行為符合預期` |
    | Skill 修正 bug | `- [ ] 重現原本會觸發 bug 的操作，確認問題已修正` |
    | 文件更新 | `- [ ] 確認文件內容與實際程式碼/設定一致` |

    **產生原則**：測項必須描述「做什麼操作」+「觀察什麼結果」，不可只寫「確認功能正常」這類模糊描述。

    **重要**：
    - 每個測項必須具體到可以用操作驗證，不得使用模糊描述
    - 若修改了通知邏輯，測項應包含「確認通知格式正確且有收到」
    - 若修改了 API 端點，測項應包含「確認 API 回應正確」
    - 根據 diff 內容產生更具體的測項，例如「確認 Telegram 通知包含 PR 連結」
    - 每個 PR 至少一個測項，最多不超過 5 個
    - 固定附加：`- [ ] 確認無敏感資訊外洩`

14. **建立 PR**：
    ```bash
    gh pr create \
      --title "{title}" \
      --body "{body}" \
      {若 --draft: --draft}
    ```

### Phase 6: Post-PR

15. **顯示結果**：
    - PR URL
    - 部署提示：merge 後可用 `workflow_dispatch` 觸發部署
    - 若有需要 restart 的變更，額外提醒

16. **PR 監控判斷**：
    - 若 `--no-push` 或 `--no-monitor` → workflow 結束，跳過監控
    - 若 `--monitor` → 直接進入 Phase 7，跳過確認
    - 否則，**🔴 Checkpoint D — BLOCKING**：呼叫 `AskUserQuestion` 工具詢問是否啟動 PR 監控：
      - 顯示選項：「要啟動 PR 狀態監控嗎？（merge 後自動驗證 / changes requested 自動修復）」
      - 使用者回答「是」→ 進入 Phase 7
      - 使用者回答「否」→ workflow 結束
      - 收到回應前**禁止執行任何後續動作**

### Phase 7: PR Status Monitor

**目標**：監控 PR 狀態，自動處理 merge 和 review feedback。

**執行方式**：Agent 進入 loop 模式，每 2 分鐘輪詢一次（`sleep 120` + `gh pr view`）。此 loop 會佔用主 session，超過 2 小時自動停止。

**防重複機制**：記錄 `lastHandledReviewAt` 時間戳，只處理比此時間更新的 CHANGES_REQUESTED review，避免對同一筆 review 重複觸發修復。

17. **進入 PR 狀態輪詢 loop**：

    初始化：`lastHandledReviewAt` = 當前時間（PR 建立時）

    每 2 分鐘執行：
    ```bash
    sleep 120
    gh pr view {PR_NUMBER} --json state,reviewDecision,reviews
    ```

    根據回傳結果判斷：

    | `state` | `reviewDecision` | 動作 |
    |---------|------------------|------|
    | `MERGED` | any | → Step 18（Merge 路徑） |
    | `OPEN` | `CHANGES_REQUESTED` 且有 `submittedAt` > `lastHandledReviewAt` 的新 review | → Step 19（Changes Requested 路徑），處理後更新 `lastHandledReviewAt` |
    | `OPEN` | `CHANGES_REQUESTED` 但無新 review（已處理過） | 繼續等待（等 reviewer re-review） |
    | `OPEN` | `APPROVED` / 無 | 繼續等待 |
    | `CLOSED`（未 merge） | any | 通知使用者 PR 已關閉，停止監控 |

    **停止條件**：
    - PR 已 merged 且驗證完成
    - PR 被關閉（未 merge）
    - 使用者手動中止
    - 超過 2 小時

18. **Merge 路徑 — 觸發 Post-Deploy 驗證**：

    偵測到 PR 已 merge 後：

    1. 通知使用者（若有設定 Telegram 則同時發送通知）：
       ```
       ✅ PR #{PR_NUMBER} 已被 merge！正在啟動 post-deploy 驗證...
       ```

    2. 等待部署完成（若有 GitHub Actions deploy workflow，等待其結束）：
       ```bash
       # 查找 deploy workflow 並檢查最近的 run
       gh run list --limit=3 --json workflowName,status,conclusion \
         --jq '.[] | select(.workflowName | test("deploy|Deploy"))'
       ```
       - 若有 `in_progress` 的 run → 每 30 秒檢查一次直到完成
       - 若無 deploy workflow 或已完成 → 直接進行驗證

    3. 呼叫 `verify-pr` skill，傳入 PR 編號執行 post-deploy 驗證

    4. 驗證完成後停止監控

19. **Changes Requested 路徑 — 自動修復並重推**：

    偵測到新的 `CHANGES_REQUESTED`（`submittedAt` > `lastHandledReviewAt`）後：

    **Step 19a: 收集 review 意見和 PR 檔案清單**

    ```bash
    # 取得 PR 涉及的檔案清單（用於安全修改判斷）
    gh pr diff {PR_NUMBER} --name-only

    # 取得 PR review comments（行內評論）
    gh api repos/{owner}/{repo}/pulls/{PR_NUMBER}/comments \
      --jq '.[] | select(.in_reply_to_id == null) | {path, line, body, user: .user.login}'

    # 取得 PR review 總評（整體 review 意見）
    gh pr view {PR_NUMBER} --json reviews \
      --jq '.reviews[] | select(.state == "CHANGES_REQUESTED") | {body, author: .author.login, submittedAt}'
    ```

    **Step 19b: 分析修改範圍，判斷安全性**

    逐條分析 review 意見，判斷每條是否為「安全修改」。

    以 Step 19a 取得的 PR 檔案清單作為「原始 PR 範圍」：

    **「安全修改」— 全部符合才自動執行**：
    - 修改範圍在原始 PR 涉及的檔案內（與 `gh pr diff --name-only` 的結果比對）
    - 修改性質為：命名調整、格式修正、補充註解、小幅邏輯修正、錯字修正
    - 不涉及架構變更、新增依賴、或改變原始功能目標
    - 修改意圖明確，無歧義

    **「需使用者介入」— 任一條成立即觸發**：
    - Review 要求的方向與原始 PR 目標衝突
    - 需要修改原始 PR 未涉及的檔案
    - 涉及架構決策或設計取捨
    - Review 意見模糊，無法確定具體修改方式
    - 修改影響部署策略（如需額外 restart）
    - Reviewer 意見彼此矛盾

    **Step 19c: 執行修改**

    **若全部為安全修改**：

    1. 逐條執行修改
    2. 記錄每條修改的原因和對應的 review comment
    3. Commit（此為自動修復 commit，不經 Checkpoint C 確認）：
       ```bash
       git add {modified_files}
       git commit -m "fix: 根據 code review 修正 — {具體描述}"
       ```
    4. Push：
       ```bash
       git push
       ```
    5. 通知使用者（若有設定 Telegram 則同時發送）：
       ```
       🔧 PR #{PR_NUMBER} 已根據 review 自動修正並推送：
       - {修改摘要 1}
       - {修改摘要 2}
       ```
    6. 更新 `lastHandledReviewAt` 為最新 review 的 `submittedAt`
    7. 回到 Step 17 繼續輪詢

    **若有任何不安全修改**：

    1. 呼叫 `AskUserQuestion` 呈現完整分析：
       ```
       📋 PR #{PR_NUMBER} 收到 changes requested，以下需要你確認：

       🔧 可自動修改（{N} 項）：
       - {描述} — 來自 {reviewer} 的建議

       ⚠️ 需要你決定（{M} 項）：
       - {描述} — 原因：{為什麼判斷為不安全}

       請告訴我：
       1. 自動修改的部分要執行嗎？
       2. 需要你決定的部分要怎麼處理？
       ```
    2. 等使用者回應後執行對應動作
    3. Commit + Push 後更新 `lastHandledReviewAt`，回到 Step 17 繼續輪詢

    **Step 19d: 修改失敗處理**

    若自動修改過程中失敗（如 commit hook 不過、merge conflict 等）：

    1. 還原本次修改涉及的檔案（僅還原本次修改的檔案，不影響其他工作）：
       ```bash
       git checkout -- {本次修改的檔案清單}
       ```
    2. 通知使用者：
       ```
       ❌ PR #{PR_NUMBER} 自動修復失敗：{錯誤原因}
       請手動處理。Review 意見摘要：
       - {review 意見列表}
       ```
    3. 回到 Step 17 繼續輪詢（等使用者手動修復後可能觸發新的 review）

## Commit Message Convention

所有 commit 訊息使用**繁體中文**，格式：
```
{type}: {描述}
```

常見 type：
- `feat`: 新增功能或 skill
- `update`: 更新既有內容
- `fix`: 修復問題
- `chore`: 維護性變更（config 等）
- `ci`: CI/CD 相關
- `docs`: 文件更新

## Validation Checklist

- [ ] `gh` CLI 已登入
- [ ] 無敏感檔案被 commit
- [ ] 分支名稱符合命名規則
- [ ] Commit message 使用繁體中文
- [ ] PR body 包含部署注意事項和具體 Post-Deploy 驗證項目
- [ ] 使用者已確認所有操作
- [ ] Checkpoint D 使用 `AskUserQuestion` 詢問是否啟動監控
- [ ] 背景 Agent 正確輪詢 PR 狀態
- [ ] Merge 路徑正確呼叫 verify-pr
- [ ] Changes Requested 路徑正確判斷安全/不安全修改
- [ ] 自動修改失敗時有 fallback 處理
