# 兌換問題處理

> **相關 Spec 參考**
> - [02-order-flow.md](../specs/02-order-flow.md) - 訂單狀態流轉與兌換流程
> - [03-order-types.md](../specs/03-order-types.md) - Swap 訂單類型定義（雙向 Transfer）
> - [04-billing.md](../specs/04-billing.md) - 滑點設定與價格追蹤
> - [06-integrations.md](../specs/06-integrations.md) - RabbitMQ Queue 與 Cryp 回調
> - [troubleshooting/03-swap.md](../specs/troubleshooting/03-swap.md) - 兌換排查速查

> **ELK 查詢指引**
> - **cams-api**：兌換 API 請求相關日誌
> - **cams-job**：swap_from/swap_to Transfer 執行、交易所操作、通知等背景任務日誌
> - 常用搜尋欄位：`order_id`、`merchant_order_id`、`transfer_id`

## 適用情境

商戶回報兌換 (Swap) 相關問題，包括：兌換卡住未完成、兌換滑點失敗、兌換通知商戶失敗。

## 關鍵概念

- 每筆 Swap 訂單產生 **兩筆 Transfer**：`swap_from`（換出）和 `swap_to`（換入）
- 兩筆 Transfer **都完成才算訂單成功**
- Swap 只在同一條鏈上的不同代幣間執行
- RabbitMQ queue：`swap.create_transfer`（Worker 數 1，Prefetch 50）

---

## 情境一：兌換卡住未完成

### 觸發條件

商戶提交兌換請求後長時間未收到結果。

### 診斷步驟

1. **取得關鍵資訊**
   - OrderID (SW 前綴) 或 MerchantOrderID
   - FromToken（換出代幣）、ToToken（換入代幣）

2. **查詢訂單狀態**
   - 用 OrderID 查 ELK 確認 Swap 訂單的 Status

3. **查詢兩筆 Transfer 狀態**
   - 用 OrderID 分別查 `swap_from` 和 `swap_to` 的 Transfer
   - `swap_from`：透過 `RelatedFromOrderID` 關聯
   - `swap_to`：透過 `RelatedToOrderID` 關聯

4. **根據 Transfer 狀態組合判斷**

| swap_from | swap_to | 說明 | 處理 |
|-----------|---------|------|------|
| 未建立 | 未建立 | Transfer 建立失敗 | 查 `swap.create_transfer` queue，確認 cams-job 消費狀態 |
| 處理中 | 未開始 | 換出交易尚在鏈上 | 查 cryp 端交易狀態 |
| 成功 | 未完成 | 換出成功但換入未到 | 查 swap_to 的 cryp 回調；可能鏈上執行中 |
| 成功 | 成功 | 兩筆都完成 | 檢查訂單狀態更新 log，可能是狀態同步延遲 |
| 失敗 | - | 換出失敗 | 查失敗原因，可能是 Gas 不足或合約錯誤 |

5. **注意 Worker 數量**
   - `swap.create_transfer` 只有 **1 個 Worker**，高並發時可能排隊
   - 若大量 Swap 訂單同時卡住，檢查 queue 積壓情況

---

## 情境二：兌換滑點失敗

### 觸發條件

兌換訂單失敗，原因為實際匯率偏差超過商戶設定的滑點容許範圍。

### 診斷步驟

1. **查詢匯率資訊**
   - 查 Swap 訂單的 `Rate`（預期匯率）和 `ActualRate`（實際匯率）
   - 計算偏差百分比：`|(ActualRate - Rate) / Rate| * 100`

2. **查詢商戶滑點設定**
   - 查 Merchant 的 `SwapSlippage` 設定值（百分比）

3. **判斷**

| 狀況 | 處理 |
|------|------|
| 偏差確實超過滑點 | 正常行為，交易被正確拒絕；建議商戶調高滑點或在市場波動小時操作 |
| 偏差未超過但仍失敗 | 查 log 確認是否有其他失敗原因 |
| 頻繁滑點失敗 | 建議檢查價格來源是否正常（TradingPair 價格同步），或評估滑點設定是否過小 |

4. **確認價格來源**
   - 查 TradingPair 最近的價格更新時間
   - 確認價格同步排程（每 10 分鐘）是否正常
   - 比對交易所實際價格與系統記錄價格

---

## 情境三：兌換通知商戶失敗

### 觸發條件

兌換訂單已完成但商戶未收到通知。

### 診斷步驟

1. **查詢通知狀態**
   - 用 OrderID 查 Swap 的 `NotifyStatus` 和 `NotifyCount`

2. **確認商戶設定**
   - 檢查 `NotifySwapURL` 是否正確設定且可達
   - 確認 `SecretKey` 簽名

3. **手動重試**
   - 修正問題後透過後台重試
   - 注意 2 分鐘 Redis 鎖

### 通知內容欄位

商戶收到的兌換通知包含：`swap_order`, `from_crypto`, `actual_from_amount`, `to_crypto`, `actual_to_amount`, `transaction_time`, `returncode`
