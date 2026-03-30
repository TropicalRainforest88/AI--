# 提現問題處理

> **相關 Spec 參考**
> - [02-order-flow.md](../specs/02-order-flow.md) - 訂單狀態流轉與提現流程
> - [03-order-types.md](../specs/03-order-types.md) - Withdraw 訂單類型定義
> - [04-billing.md](../specs/04-billing.md) - 資金流轉（歸集/下發）
> - [06-integrations.md](../specs/06-integrations.md) - RabbitMQ Queue 與 Cryp 回調
> - [troubleshooting/02-withdraw.md](../specs/troubleshooting/02-withdraw.md) - 提現排查速查

> **ELK 查詢指引**
> - **cams-api**：提現 API 請求、商戶發起提現相關日誌
> - **cams-job**：Transfer 執行、cryp 回調、提現通知等背景任務日誌
> - 常用搜尋欄位：`order_id`、`merchant_order_id`、`transfer_id`、`tx_hash`

## 適用情境

商戶回報提現相關問題，包括：提現卡住未處理、提現失敗、提現錢包餘額不足、提現通知商戶失敗。

## 情境一：提現卡住未處理

### 觸發條件

商戶提交提現請求後長時間未收到結果回調，訂單停留在非最終狀態。

### 診斷步驟

1. **取得關鍵資訊**
   - OrderID (WD 前綴) 或 MerchantOrderID
   - 商戶 ID、代幣、金額

2. **查詢訂單當前狀態**
   - 用 OrderID 查 ELK 或資料庫確認訂單當前 Status

3. **根據卡住狀態排查**

| 卡住狀態 | 可能原因 | 排查方式 |
|----------|----------|----------|
| Pending (0) | RabbitMQ 消費異常 | 查 `withdraw.create_transfer` queue 是否正常消費；確認 cams-job 是否存活 |
| CreateTransfer (1) | Transfer 建立中卡住 | 查 Transfer 建立 log，可能是錢包選擇失敗 |
| CreateTransferFail (2) | Transfer 建立失敗 | 查失敗原因，確認是否可重試 |
| TransferCreated (3) | 等待執行 | 查 `transfer.execute_transfer` queue |
| PreTransfer (4) | 準備轉帳中 | 查 cryp 呼叫 log |
| ProcessTransfer (5) | 鏈上轉帳執行中 | 查 cryp 端交易狀態，可能鏈上擁堵 |
| WaitRetryTransfer (6) | 等待重試 | 確認重試排程是否正常 |
| Confirming (7) | 等待鏈上確認 | 查鏈上交易確認狀態，可能區塊確認較慢 |
| AuditPending (13) | 等待人工審核 | 通知審核人員處理 |
| PendingManualReview (14) | 需人工介入 | 查 Transfer 狀態，確認異常原因 |

4. **檢查 Transfer 狀態**
   - 用 OrderID 的 `RelatedFromOrderID` 找到對應 Transfer (TR 前綴)
   - Transfer 類型應為 `withdraw`
   - 查 Transfer 的獨立狀態碼

---

## 情境二：提現失敗

### 觸發條件

提現訂單狀態為 Failed (9)，商戶詢問失敗原因。

### 診斷步驟

1. **查詢失敗原因**
   - 用 OrderID 查 ELK，搜尋錯誤 log
   - 確認 Transfer 的失敗狀態與錯誤訊息

2. **常見失敗原因**

| 原因 | 說明 | 處理 |
|------|------|------|
| 提現錢包餘額不足 | 無可用的 withdraw 錢包有足夠餘額 | 見情境三 |
| 鏈上交易失敗 | Gas 不足、合約執行錯誤 | 查 TxHash 確認鏈上失敗原因 |
| 重試次數耗盡 | RetryCount 達到 WithdrawRetryCount 上限 | 確認商戶的重試次數設定，評估是否需要調整 |
| cryp 服務異常 | cryp 端執行失敗 | 轉交 cryp 團隊排查 |
| 目標地址異常 | ToAddress 格式錯誤或不存在 | Transaction 狀態為 StatusTXAddressNotExist (5) |
| 交易資料異常 | Transfer 狀態為 StatusTRDataAnomaly (14) | 需人工確認資料並修正 |

3. **檢查重試機制**
   - 確認 `RetryCount` 當前值
   - 確認商戶設定的 `WithdrawRetryCount` 上限
   - 若未達上限但未重試 → 查重試 log，確認 `transfer.execute_transfer` queue

---

## 情境三：提現錢包餘額不足

### 觸發條件

提現持續失敗，原因為無可用的提現錢包有足夠餘額執行提現。

### 診斷步驟

1. **查詢提現錢包餘額**
   - 查 withdraw 類型錢包的 TokenWallet 餘額 (HoldingAmount)
   - 確認是否有多個提現錢包，各自餘額多少

2. **查詢下發狀態**
   - 確認下發排程是否正常運作（每 2 分鐘執行一次）
   - 查 `wallet.distribution` queue 的消費 log
   - 查最近的 distribute 類型 Transfer 狀態

3. **查詢歸集錢包餘額**
   - 確認 collection 類型錢包的餘額
   - 若歸集錢包也餘額不足 → 查歸集狀態

4. **資金流向追蹤**
   ```
   用戶錢包 (user) → [collection] → 歸集錢包 (collection) → [distribute] → 提現錢包 (withdraw)
   ```
   - 逐步確認資金在哪個環節卡住

5. **處理方式**

| 狀況 | 處理 |
|------|------|
| 下發排程異常 | 檢查 cams-job 是否存活，RabbitMQ 連線是否正常 |
| 歸集錢包餘額不足 | 確認歸集是否正常運作（每 3 分鐘），或是否有大額充值尚未歸集 |
| 整體資金不足 | 需要從外部補充資金到系統錢包 |

---

## 情境四：提現通知商戶失敗

### 觸發條件

提現訂單已達最終狀態（Success/Failed），但商戶未收到通知。

### 診斷步驟

1. **查詢通知狀態**
   - 用 OrderID 查 Withdraw 的 `NotifyStatus` 和 `NotifyCount`

2. **根據通知狀態處理**

| NotifyStatus | 說明 | 處理 |
|--------------|------|------|
| 0 (待處理) | 通知尚未發送 | 查通知排程 log |
| 1 (成功) | 通知已成功 | 確認商戶端處理邏輯 |
| 2 (重試達上限) | 商戶端無法接收 | 確認 NotifyWithdrawURL 是否正確可達 |
| 3 (重試中) | 正在重試 | 等待重試 |
| 4 (不需要通知) | 未設定 URL | 確認商戶 NotifyWithdrawURL 設定 |

3. **確認商戶設定**
   - 檢查 `NotifyWithdrawURL` 是否正確
   - 測試 URL 可達性
   - 確認 `SecretKey` 簽名驗證

4. **手動重試**
   - 修正問題後可透過後台重試通知
   - 注意 2 分鐘 Redis 鎖

### 通知內容欄位

商戶收到的提現通知包含：`memberid`, `orderid`, `withdraw_order`, `bankcode`, `amount`, `onchain_at`, `returncode`, `sign`
