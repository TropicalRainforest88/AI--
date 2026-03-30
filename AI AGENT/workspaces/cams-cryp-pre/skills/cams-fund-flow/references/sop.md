# 資金流轉問題處理

> **相關 Spec 參考**
> - [01-glossary.md](../specs/01-glossary.md) - Collection、Distribution、Supplement Fee 定義
> - [04-billing.md](../specs/04-billing.md) - 歸集/下發狀態、代幣限額設定、手續費機制
> - [06-integrations.md](../specs/06-integrations.md) - RabbitMQ Queue（wallet.collection / wallet.distribution）與排程任務
> - [troubleshooting/06-fund-flow.md](../specs/troubleshooting/06-fund-flow.md) - 資金流轉排查速查

> **ELK 查詢指引**
> - **cams-job**：歸集（HandleCollectFunds）、下發（HandleDistributeFunds）、手續費補充等排程日誌
> - 資金流轉主要為背景任務，日誌集中在 `cams-job`
> - 常用搜尋欄位：`wallet_id`、`transfer_id`、`collection_status`、`distribution_status`

## 適用情境

歸集 (Collection) 或下發 (Distribution) 流程異常，導致資金未正確流轉。

## 資金流向

```
用戶錢包 (user) ──[collection]──→ 歸集錢包 (collection) ──[distribute]──→ 提現錢包 (withdraw)
```

---

## 情境一：歸集未觸發

### 觸發條件

用戶錢包持續累積餘額，但未自動歸集到歸集錢包。

### 診斷步驟

1. **確認觸發條件**
   - 查用戶錢包的 TokenWallet.HoldingAmount
   - 查 Token 設定的 `UserWalletLimit`
   - 歸集條件：`HoldingAmount > UserWalletLimit`

2. **確認排程狀態**
   - 歸集排程：`HandleCollectFunds`，每 **3 分鐘** 執行
   - 查 ELK 中排程執行 log
   - 確認 cams-job 是否正常運作

3. **確認 RabbitMQ 狀態**
   - 查 `wallet.collection` queue（Worker 20, Prefetch 20）
   - 確認 queue 是否有積壓或消費異常

4. **確認歸集狀態欄位**
   - 查 TokenWallet 的歸集狀態（CollectionStatus）

| 歸集狀態 | 說明 | 處理 |
|----------|------|------|
| 1 (待確認) | 已觸發但待確認 | 等待排程處理 |
| 2 (手續費補充中) | 正在補充 Gas | 查 supplement_fee Transfer |
| 3 (手續費補充失敗) | Gas 補充失敗 | 見情境三 |
| 4 (歸集處理中) | 正在執行歸集 | 等待鏈上確認 |
| 5 (歸集失敗) | 歸集執行失敗 | 查 collection Transfer 錯誤 |
| 6 (不需要歸集) | 未達觸發條件 | 正常狀態 |

---

## 情境二：歸集失敗

### 觸發條件

歸集已觸發但執行失敗，歸集狀態為 5 (歸集失敗)。

### 診斷步驟

1. **查詢歸集 Transfer**
   - 查 Transfer 類型 `collection` 的狀態
   - 查失敗原因 log

2. **常見失敗原因**

| 原因 | 處理 |
|------|------|
| 手續費不足 | 用戶錢包主幣不足以支付 Gas，supplement_fee 也失敗 → 手動補充主幣 |
| 歸集錢包問題 | 確認歸集錢包 (collection) 是否正常可用 |
| 鏈上交易失敗 | 查 TxHash，可能鏈擁堵或合約問題 |
| cryp 服務異常 | 轉交 cryp 團隊 |

---

## 情境三：手續費補充失敗

### 觸發條件

歸集觸發後需補充手續費（主幣/Gas），但補充失敗。

### 診斷步驟

1. **確認手續費需求**
   - 查 Token 設定的 `TransferFee`（鏈上轉帳手續費）
   - 查用戶錢包的主幣 (IsMain=true) 的 HoldingAmount
   - 當 `HoldingAmount < TransferFee` 時需要補充

2. **查詢 supplement_fee Transfer**
   - 查 Transfer 類型 `supplement_fee` 的狀態
   - 確認補充來源錢包是否有足夠主幣

3. **處理方式**
   - 若補充來源錢包也不足 → 需手動向該錢包轉入主幣
   - 確認 TRON 鏈特有費用：EnergyUsed、Fee、BandwidthFee

---

## 情境四：下發未觸發

### 觸發條件

提現錢包餘額偏低，但未自動從歸集錢包下發資金。

### 診斷步驟

1. **確認觸發條件**
   - 查提現錢包 (withdraw) 的 TokenWallet.HoldingAmount
   - 確認下發觸發的水位閾值

2. **確認排程狀態**
   - 下發排程：`HandleDistributeFunds`，每 **2 分鐘** 執行
   - 查 ELK 中排程執行 log

3. **確認 RabbitMQ 狀態**
   - 查 `wallet.distribution` queue（Worker 10, Prefetch 20）

4. **確認歸集錢包餘額**
   - 若歸集錢包餘額不足 → 下發無法執行
   - 需先確保歸集流程正常

---

## 情境五：下發失敗

### 觸發條件

下發已觸發但執行失敗。

### 診斷步驟

1. **查詢下發 Transfer**
   - 查 Transfer 類型 `distribute` 的狀態
   - 查失敗原因

2. **下發狀態確認**

| 下發狀態 | 說明 | 處理 |
|----------|------|------|
| 1 (待下發) | 已觸發待執行 | 等待排程處理 |
| 2 (下發處理中) | 正在執行 | 等待鏈上確認 |
| 3 (下發失敗) | 執行失敗 | 查 Transfer 錯誤原因 |
| 4 (下發成功) | 完成 | 正常 |
| 5 (不需要下發) | 未達觸發條件 | 正常 |

3. **常見失敗原因**

| 原因 | 處理 |
|------|------|
| 歸集錢包餘額不足 | 確認歸集流程，等待更多資金歸集 |
| Gas 不足 | 確認歸集錢包主幣餘額 |
| 鏈上交易失敗 | 查 TxHash |
| 單筆轉帳超過限額 | 查 Token 的 CollectWalletTransferLimit |
