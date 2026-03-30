---
name: cryp-notify
description: 當操作者提到 cryp通知、notify、回調、callback、notify_status、risk_control_status、商戶未收到通知、通知失敗 時觸發
metadata:
  openclaw:
    emoji: "🔔"
    requires:
      bins: ["mcporter"]
---

# CRYP 通知與告警問題診斷

## MCP 伺服器
- 名稱: cams-mcp
- 工具: search_logs, search_by_trace, get_log_context, get_error_summary, get_log_trend, list_indices, get_version
- **所有指令加 `--output json`**

| 指令 | 用途 | 關鍵參數 |
|------|------|---------|
| search_logs | 搜尋日誌 | index, query, size, level, from_time, to_time |
| search_by_trace | 用 trace_id 追蹤 | index, trace_id |
| get_log_context | 取得日誌前後文 | index, log_id, before, after |
| get_error_summary | 錯誤統計 | index, field, from_time, to_time |
| get_log_trend | 日誌趨勢 | index, interval, from_time, to_time |

## 鏈別 Index 對照表

| Index | 鏈 |
|-------|-----|
| cryp-polygon | Polygon |
| cryp-bsc | BSC |
| cryp-eth | Ethereum |
| cryp-tron | TRON |
| cryp-sol-v2 | Solana |
| cryp-arbitrum | Arbitrum |
| cryp-optimism | Optimism |
| cryp-base | Base |
| cryp-avax-cchain | Avalanche |
| cryp-ton | TON |
| cryp-btc | Bitcoin |
| cryp-dot | Polkadot |
| cryp-sui | Sui |
| cryp-sonic | Sonic |
| cryp-kaspa | Kaspa |

> **重要**：每次查詢前必須先問操作者是哪條鏈，再使用對應的 `cryp-{chain.code}` index。

## 前置知識

- notify_status：`0`=未處理, `1`=待通知, `2`=成功, `3`=失敗, `4`=無需通知
- 通知類型：
  - **TransactionNotify**（排程）：處理充值通知，Cron 定時執行
  - **WithdrawNotify**（即時 goroutine）：提幣結果通知
  - **CheckWithdraw Notify**：提幣未上鏈重試通知
- **系統不會自動重試失敗的通知**
- 通知 URL 由 merchant_type 決定：address 表 → merchant_type → 對應通知 URL
- 提幣通知時機：廣播成功 → status=0(等確認)；鏈上確認 → 最終 status
- RiskControlNotify 排程可能未在 SetupCron 中註冊
- 常用搜尋欄位：`tx_hash`、`task_name`、`notify_status`

## 診斷流程

### 情境一：交易通知未發送

收集：tx_hash、notify_status、ELK 中 TransactionNotify log

依 notify_status 判斷：

**notify_status = 0（未處理）**
- 交易尚未被 TransactionConfirm 處理（transaction.status 仍為 0）
- notify_status 在交易確認後才會變為 1
- 先確認交易確認狀態，參考 cryp-deposit skill 情境二

**notify_status = 1（待通知）**
查 TransactionNotify：
```
cams-mcp.search_logs --index cryp-{chain} --query "task_name:TransactionNotify" --size 20 --output json
```
- `get notify host error` → 無法取得商戶通知 URL。**請 RD 查詢 DB**：`SELECT address, merchant_type FROM address WHERE address = '交易地址';` 確認 merchant_type 有對應通知 URL
- HTTP 回調錯誤 → 商戶端問題，查日誌 curl 欄位可直接複製測試
- 無 TransactionNotify 日誌 → 排程未執行，確認 Cron Worker 狀態
- **請 RD 查詢 DB**：`SELECT COUNT(*) FROM transaction WHERE notify_status = 1;` 確認是否大量積壓

**notify_status = 2（成功）**
- cryp 端已成功送達，問題在商戶端

**notify_status = 3（失敗）**
- 系統不會自動重試。查錯誤原因：
```
cams-mcp.search_logs --index cryp-{chain} --query "create transaction notify error" --level error --output json
```
- 常見原因：商戶服務不可達、回傳非 200、網路問題
- 修正後需手動觸發重新通知或由商戶主動查詢

**notify_status = 4（無需通知）**
- 該交易標記為無需通知，屬正常行為

### 情境二：提幣通知未觸發

收集：transfer_id 或 tx_hash、withdraw.status

- status=0 → 提幣尚未完成，不會通知。參考 cryp-withdraw skill
- status=1 或 2 → 查通知 log：
```
cams-mcp.search_logs --index cryp-{chain} --query "create withdraw notify" --output json
```
- `merchant type not found` → from_address 的 merchant_type 無對應通知 URL
- 無記錄 → 通知 goroutine 可能未執行，查 RunWithdraw 是否有 panic

提醒通知時機：
- 廣播成功 → 第一次通知 status=0（等確認），不是最終結果
- 鏈上確認後 → TransactionNotify 發送最終 status=1(成功) 或 2(失敗)
- 廣播失敗 → 通知 status=2（失敗）

### 情境三：CheckWithdraw 重試通知

收集：tx_hash 或 from_address、has_chain 與 has_retried 值

- has_chain=0, has_retried=0 → 符合檢查條件（建立超過 5 分鐘 + 近 7 天），系統每分鐘檢查
- has_chain=0, has_retried=1 → 已發送過重試通知，商戶需重新發起提幣
  ```
  cams-mcp.search_logs --index cryp-{chain} --query "check withdraw create txn notify" --output json
  ```
- has_chain=1 → 已上鏈確認，不需重試
- 建立不到 5 分鐘 → CheckWithdraw 會跳過，請等待

### 情境四：tx_type 與訂單類型不符

收集：transfer_id、CAMS 端的錯誤訊息

CRYP 通知 CAMS 時帶有 `tx_type`（1=充值, 2=提幣/轉帳）。若 tx_type 與實際訂單類型不一致，會導致 CAMS 以錯誤邏輯處理。

**常見症狀**：
- CAMS 錯誤 `deposit transfer already exist` — 轉帳單（TR）被 CRYP 標記為 tx_type=1（充值），CAMS 嘗試建立充值訂單時發現 transfer 已存在
- 訂單狀態卡住，CAMS 無法正常處理

**診斷步驟**：
1. 從 CAMS 日誌確認訂單前綴（TR=轉帳, WD=提幣, DE=充值）
2. 查 CRYP 通知日誌，確認回調 payload 中的 tx_type 值：
```
cams-mcp.search_logs --index cryp-{chain} --query "transfer_id:{transfer_id} AND TransactionNotify" --output json
```
3. 比對：
   - TR/WD 訂單 → 預期 tx_type=2
   - DE 訂單 → 預期 tx_type=1
   - 若不符 → **CRYP 端 bug**，tx_type 判定邏輯有誤（from_address/to_address 與系統地址表的比對結果錯誤）

**根因**：CRYP 的 tx_type 由交易方向決定（from_address 在系統地址表=提幣 type=2, to_address 在系統地址表=充值 type=1）。若地址表資料有誤或比對邏輯出錯，會導致 type 判定錯誤。

**處理**：需 CRYP RD 修復 tx_type 判定邏輯或更正地址表資料。

### 情境五：風控通知問題

收集：tx_hash、risk_control_status

- risk_control_status=0 → 注意：RiskControlNotify 排程可能未在 SetupCron 中註冊
- risk_control_status=2 → 風控處理完成
- 其他值 → 查 ELK 確認 RiskControlNotify 處理結果

### 情境六：TR/WT 轉帳通知狀態排查

當操作者問「CAMS 有沒有收到 CRYP 的通知」或「TR 單為何沒更新」時使用。

**必須依序執行以下步驟，不可跳過：**

**Step 1：從 CAMS 端找建單記錄**
```
cams-mcp.search_logs --index cams-job --query "TR{order_id}" --size 20 --output json
```
- 取得 `transfer_id`（UUID 格式）、`from_address`、`to_address`、`amount`、`chain_type`
- 記下建單時間作為後續查詢的起始時間

**Step 2：在 CAMS 端確認是否收到通知（此步不可跳過！）**
```
cams-mcp.search_logs --index cams-job --query "record transaction notify request" --from_time {建單時間-5min} --to_time {建單時間+2h} --size 50 --output json
```
- 在結果中搜尋匹配的 `from_address` 或 `to_address`
- 若找到 → CAMS 已收到通知，問題在 CAMS 匹配/處理邏輯（進入 Step 3）
- 若未找到 → CAMS 未收到通知，問題可能在 CRYP 端（進入 Step 4）

**Step 3：CAMS 收到通知但 TR 未更新**
- 從 Step 2 的通知 log 取得 `tx_hash`
- 用 `tx_hash` 搜 cams-job 確認後續處理：
```
cams-mcp.search_logs --index cams-job --query "{tx_hash}" --size 20 --output json
```
- 檢查是否有 `handler receive transaction notify` 記錄
- 檢查是否建了 TX 單而非更新 TR 單（表示匹配失敗）
- **結論歸屬 CAMS 端**，需 RD 檢查通知匹配邏輯

**Step 4：CAMS 未收到通知，查 CRYP 端**
- 用 `from_address` 或 `to_address` 搜 cryp-{chain}：
```
cams-mcp.search_logs --index cryp-{chain} --query "{from_address}" --from_time {建單時間-5min} --to_time {建單時間+2h} --size 20 --output json
```
- 若找到 tx_hash 和通知記錄 → CRYP 有發但 CAMS 沒收到，查網路/介面問題
- 若完全沒記錄 → CRYP 未偵測到鏈上交易，**結論歸屬 CRYP 端**

## 搜尋 Fallback 策略

> **規則：搜尋返回 null 時，禁止直接下「不存在」結論。必須嘗試至少 3 種搜法。**

| 優先順序 | 搜尋方式 | 範例 |
|----------|---------|------|
| 1 | 全文搜尋地址（不帶 field prefix） | `query="{from_address}"` |
| 2 | 從 cams-job 搜通知接收 log 反查 tx_hash | `query="record transaction notify request"` + 時間範圍 |
| 3 | 用 tx_hash 跨 index 搜尋 | `query="{tx_hash}"` 同時搜 cams-job 和 cryp-{chain} |
| 4 | 放寬時間範圍重試 | 擴大 from_time/to_time 各 1 小時 |

**常見搜尋陷阱**：
- `transfer_id:TR20260313001090` → 錯誤！TR 開頭是 CAMS 的 order_id，不是 cryp-{chain} index 的 transfer_id
- `transfer_id:{uuid}` 在 cryp-{chain} 可能因欄位映射問題返回 null → 改用全文搜尋 UUID
- cryp-{chain} index 的 `@timestamp` 映射可能缺失（已知：cryp-sui, cryp-dot, cryp-sol-v2） → 改從 cams-job 側查

## 歸責前驗證規則

> **在判定問題歸屬前，必須同時確認 CAMS 端和 CRYP 端的 log。**

1. **雙邊確認**：必須查完 cams-job（通知接收）和 cryp-{chain}（通知發送）才能下結論
2. **區分事實與推測**：明確標示「已從 log 確認」vs「尚未確認，需進一步查證」
3. **業務邏輯不確定時**：標注「需要 code review 確認匹配邏輯」，不要自行假設行為
4. **禁止單邊歸責**：不可僅憑 cryp-{chain} 搜不到就歸咎 CRYP，也不可僅憑 cams-job 搜不到就歸咎 CAMS
