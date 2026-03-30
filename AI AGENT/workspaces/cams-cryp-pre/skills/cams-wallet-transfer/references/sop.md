# 錢包轉帳問題處理

> **相關 Spec 參考**
> - [03-order-types.md](../specs/03-order-types.md) - WalletTransfer 訂單類型與審核狀態定義
> - [04-billing.md](../specs/04-billing.md) - 角色轉帳限額 (DailyTransferLimit)
> - [05-users-permissions.md](../specs/05-users-permissions.md) - 角色權限與 wallet > transfer 權限
> - [06-integrations.md](../specs/06-integrations.md) - 排程任務 HandlerTimeoutWalletTransfer
> - [troubleshooting/05-wallet-transfer.md](../specs/troubleshooting/05-wallet-transfer.md) - 錢包轉帳排查速查

> **ELK 查詢指引**
> - **cams-api**：錢包轉帳發起、審核操作相關日誌
> - **cams-job**：審核超時排程（HandlerTimeoutWalletTransfer）、Transfer 執行等背景任務日誌
> - 常用搜尋欄位：`order_id`、`transfer_id`、`audit_status`

## 適用情境

後台管理人員回報錢包轉帳 (WalletTransfer) 相關問題，包括：審核超時、審核被否決、角色轉帳限額問題、轉帳執行失敗。

## 關鍵概念

- 錢包轉帳由後台管理人員發起，非商戶 API
- 需經過審核流程（除非設定為不需審核）
- 審核超時時限為 **2 小時**，由排程任務每 10 分鐘檢查
- 每個角色有 `DailyTransferLimit`（每日轉帳上限），admin 免除 USDT 限額
- Transfer 類型為 `internal`，透過 `RelatedFromOrderID` 關聯

---

## 情境一：錢包轉帳審核超時

### 觸發條件

WalletTransfer 的 AuditStatus 為超時 (4)，操作者詢問為何轉帳未執行。

### 診斷步驟

1. **確認超時狀態**
   - 用 OrderID (WT) 查 ELK
   - 確認 `AuditStatus = 4` (StatusWalletTransferAuditTimeout)
   - 查 `AuditAt` 時間確認超時計算

2. **確認審核機制**
   - 審核超時時限：2 小時
   - 排程任務 `HandlerTimeoutWalletTransfer` 每 10 分鐘執行
   - 超時後自動設為審核否決，並回滾錢包餘額

3. **處理方式**
   - 超時後需重新發起錢包轉帳申請
   - 確認餘額已正確回滾
   - 建議審核人員在時限內處理待審核項目

---

## 情境二：錢包轉帳被否決

### 觸發條件

WalletTransfer 的 AuditStatus 為否決 (3)，操作者詢問原因。

### 診斷步驟

1. **查詢否決原因**
   - 查 `AuditReason` 欄位了解審核人否決的理由
   - 查 `ExtData` 中的審核人資訊

2. **確認餘額回滾**
   - 否決時系統自動回滾錢包餘額
   - 確認來源錢包的 TokenWallet.HoldingAmount 是否已恢復

3. **處理方式**
   - 根據否決原因調整後重新發起
   - 若認為否決不當，聯繫審核人溝通

---

## 情境三：角色轉帳限額不足

### 觸發條件

發起錢包轉帳時被系統拒絕，提示超過每日轉帳限額。

### 診斷步驟

1. **查詢角色限額**
   - 確認操作者的角色
   - 查 `RoleWalletTransferLimit` 中該角色的 `DailyTransferLimit`

2. **計算當日已用額度**
   - 統計該角色當日已成功的 WalletTransfer 總金額

3. **處理方式**

| 狀況 | 處理 |
|------|------|
| 確實超過限額 | 等待次日重置，或由 admin 角色執行（admin 免除 USDT 限額） |
| 限額設定過低 | 由有權限的管理員調整角色的 DailyTransferLimit |
| 緊急轉帳需求 | 由 admin 角色代為執行 |

---

## 情境四：錢包轉帳執行失敗

### 觸發條件

審核通過後，實際執行鏈上轉帳時失敗。

### 診斷步驟

1. **查詢 Transfer 狀態**
   - 用 OrderID 找到對應的 Transfer (類型 `internal`)
   - 確認 Transfer 的失敗狀態與錯誤訊息

2. **常見失敗原因**

| 原因 | 處理 |
|------|------|
| Gas 不足 | 確認來源錢包的主幣餘額 |
| 來源錢包餘額不足 | 確認 TokenWallet.HoldingAmount |
| cryp 執行失敗 | 查 cryp 端 log |
| 鏈上交易失敗 | 查 TxHash 確認失敗原因 |
