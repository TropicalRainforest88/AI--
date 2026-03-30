# 充值問題處理

> **相關 Spec 參考**
> - [00-overview.md](../specs/00-overview.md) - 系統總覽
> - [02-order-flow.md](../specs/02-order-flow.md) - 訂單狀態流轉與充值流程
> - [03-order-types.md](../specs/03-order-types.md) - Deposit 訂單類型定義
> - [06-integrations.md](../specs/06-integrations.md) - Cryp 回調機制與風險偵測
> - [troubleshooting/01-deposit.md](../specs/troubleshooting/01-deposit.md) - 充值排查速查

> **ELK 查詢指引**
> - **cams-api**：充值 API 請求、訂單查詢相關日誌
> - **cams-job**：cryp 回調處理、充值通知、風險偵測等背景任務日誌
> - 常用搜尋欄位：`order_id`、`tx_hash`、`to_address`、`merchant_order_id`

## 適用情境

用戶或商戶回報充值相關問題，包括：充值未入帳、充值被標記風險地址、充值通知商戶失敗。

## 情境一：充值未入帳

### 觸發條件

用戶已在鏈上完成轉帳，但 CAMS 中無對應 Deposit 訂單，或訂單狀態未到達 Success。

### 診斷步驟

1. **取得關鍵資訊**
   - 向回報者確認：TxHash、ToAddress（充值地址）、鏈與代幣、轉帳金額、轉帳時間
   - 若有 OrderID (DE 前綴) 直接用 OrderID 查詢

2. **查詢 ELK 確認 cryp 回調**
   - 用 TxHash 或 ToAddress 搜尋 log
   - 確認是否有收到 cryp 的 `ReceiveTransactionNotify` 回調記錄

3. **根據回調狀態分流判斷**

| 狀況 | 原因 | 處理方式 |
|------|------|----------|
| 無回調記錄 | cryp 端未偵測到交易，或鏈上交易尚未確認 | 確認鏈上交易狀態（區塊確認數）；若交易已確認則轉交 cryp 團隊排查 |
| 有回調但無 Deposit 訂單 | Transaction 或 Deposit 建立失敗 | 查 log 中的錯誤訊息，確認是否有 DB 寫入錯誤 |
| 有 Deposit 但狀態非 Success | 訂單卡在中間狀態 | 依訂單狀態進一步排查（見下方） |

4. **檢查最小充值金額**
   - 查 Token 設定中的 `MinDepositAmount`
   - 若轉帳金額低於最小金額 → 系統正常忽略，非異常

5. **檢查商戶與代幣設定**
   - 確認商戶的 `DepositStatus` 是否為啟用
   - 確認該代幣是否已在商戶的代幣設定中啟用

### 訂單狀態排查

| 卡住狀態 | 可能原因 | 處理 |
|----------|----------|------|
| Pending (0) | 訂單剛建立 | 等待系統處理，若超過 5 分鐘查 log |
| CreateTransfer (1) | Transfer 建立中 | 查 Transfer 建立 log |
| CreateTransferFail (2) | Transfer 建立失敗 | 查失敗原因，可能是資料驗證失敗 |
| PendingManualReview (14) | 需人工處理 | 查 Transfer 狀態，可能存在 DataAnomaly |

---

## 情境二：充值被標記風險地址

### 觸發條件

充值入帳但 Transfer 狀態為 `StatusTRRiskAddress (11)`，商戶詢問為何資金被標記。

### 診斷步驟

1. **用 OrderID (DE) 查詢訂單與 Transfer**
   - 確認 Transfer 狀態為 `StatusTRRiskAddress`
   - 取得來源地址 (FromAddress)

2. **查詢風險偵測來源**
   - 在 ELK 搜尋風險檢查 log
   - 確認是 TronScan 還是 OKX 標記
   - 取得 `RedTag`（風險標籤）內容

3. **評估與處理**

| 風險等級 | 處理方式 |
|----------|----------|
| 確認為風險地址 | 依公司政策決定是否啟動「風險地址充值退還」流程 |
| 誤判可能性高 | 記錄並回報風控團隊評估是否需要白名單處理 |

### 風險地址充值退還流程

- 系統支援將風險地址的充值資金原路退還
- 退還操作會建立對應的退還 Transfer
- 需確認退還目標地址（通常為原始 FromAddress）

---

## 情境三：充值通知商戶失敗

### 觸發條件

充值訂單已成功 (Status=8)，但商戶未收到通知回調。

### 診斷步驟

1. **查詢通知狀態**
   - 用 OrderID 查詢 Deposit 的 `NotifyStatus` 和 `NotifyCount`

2. **根據通知狀態處理**

| NotifyStatus | 說明 | 處理 |
|--------------|------|------|
| 0 (待處理) | 通知尚未發送 | 查 log 確認通知排程是否正常 |
| 1 (成功) | 通知已成功 | 確認商戶端是否有收到但未正確處理 |
| 2 (重試達上限) | 商戶端無法接收 | 確認商戶 NotifyDepositURL 是否正確可達 |
| 3 (重試中) | 正在重試 | 等待重試完成 |
| 4 (不需要通知) | 未設定通知 URL | 確認商戶是否有設定 NotifyDepositURL |

3. **確認商戶通知設定**
   - 檢查 Merchant 的 `NotifyDepositURL` 是否正確
   - 確認 URL 是否可達（HTTP 回應 200）
   - 確認商戶 `SecretKey` 是否正確（用於簽名驗證）

4. **手動重試通知**
   - 若問題已修正，可透過後台手動重試通知
   - 注意 Redis 鎖機制：每筆訂單有 2 分鐘的通知鎖，避免重複通知

### 通知內容欄位

商戶收到的充值通知包含：`memberid`, `merchant_order`, `bankcode`, `from_address`, `address`, `amount`, `onchain_at`, `userid`, `returncode`, `sign`
