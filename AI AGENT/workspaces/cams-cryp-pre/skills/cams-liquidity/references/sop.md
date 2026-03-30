# 流動池問題處理

> **相關 Spec 參考**
> - [02-order-flow.md](../specs/02-order-flow.md) - 訂單狀態流轉與流動池流程
> - [03-order-types.md](../specs/03-order-types.md) - LiquidityPool 訂單類型定義（v2/v3、add/remove）
> - [04-billing.md](../specs/04-billing.md) - 滑點設定
> - [06-integrations.md](../specs/06-integrations.md) - Cryp 回調機制
> - [troubleshooting/04-liquidity-pool.md](../specs/troubleshooting/04-liquidity-pool.md) - 流動池排查速查

> **ELK 查詢指引**
> - **cams-api**：流動池 API 請求相關日誌
> - **cams-job**：liquidity_add/liquidity_remove Transfer 執行、交易所操作、通知等背景任務日誌
> - 常用搜尋欄位：`order_id`、`transfer_id`

## 適用情境

商戶回報流動池 (LiquidityPool) 相關問題，包括：操作失敗、滑點失敗、通知失敗。

## 關鍵概念

- 流動池操作分為 `add`（添加流動性）和 `remove`（移除流動性）
- 支援 v2 和 v3 兩個版本，處理邏輯不同
- v2 操作會產生 LP Token，記錄在 `ExtData` 中
- Transfer 類型：`liquidity_add`（添加）、`liquidity_remove`（移除）
- 涉及雙代幣操作（FirstToken + SecondToken）

---

## 情境一：流動池操作失敗

### 觸發條件

商戶提交流動池操作後訂單失敗或卡住。

### 診斷步驟

1. **取得關鍵資訊**
   - OrderID (LP 前綴) 或 MerchantOrderID
   - Action 類型：add 或 remove
   - Version：v2 或 v3
   - 涉及的兩種代幣

2. **查詢訂單與 Transfer 狀態**
   - 用 OrderID 查 ELK 確認 LiquidityPool 訂單 Status
   - 查對應 Transfer 狀態：
     - Add 操作 → Transfer 類型 `liquidity_add`，透過 `RelatedToOrderID` 關聯
     - Remove 操作 → Transfer 類型 `liquidity_remove`，透過 `RelatedFromOrderID` 關聯

3. **常見失敗原因**

| 原因 | 說明 | 處理 |
|------|------|------|
| 滑點超限 | 實際金額偏差超過 LiquidityPoolSlippage | 見情境二 |
| Gas 不足 | 錢包主幣餘額不足以支付手續費 | 確認錢包主幣餘額，必要時手動補充 |
| 合約執行錯誤 | 鏈上合約呼叫失敗 | 查 TxHash 確認鏈上錯誤原因 |
| cryp 服務異常 | cryp 端執行失敗 | 轉交 cryp 團隊 |
| 商戶功能未啟用 | LiquidityPoolStatus 未啟用 | 確認商戶設定 |

4. **v2 vs v3 差異排查**
   - v2：確認 ExtData 中 LP Token 資訊是否正確
   - v3：確認 price range 等 v3 特有參數

---

## 情境二：流動池滑點失敗

### 觸發條件

流動池操作因實際金額與預期金額偏差過大而失敗。

### 診斷步驟

1. **查詢金額偏差**
   - 比較 `FirstTokenAmount` vs `ActualFirstAmount`
   - 比較 `SecondTokenAmount` vs `ActualSecondAmount`
   - 計算各自的偏差百分比

2. **查詢商戶設定**
   - 查 Merchant 的 `LiquidityPoolSlippage`

3. **處理建議**
   - 若偏差確實超過滑點 → 正常行為
   - 建議商戶調整滑點設定或在市場穩定時操作
   - 確認 TradingPair 價格同步是否正常

---

## 情境三：流動池通知商戶失敗

### 觸發條件

流動池訂單已完成但商戶未收到通知。

### 診斷步驟

1. **查詢通知狀態**
   - 用 OrderID 查 `NotifyStatus` 和 `NotifyCount`

2. **確認商戶設定**
   - 檢查 `NotifyLiquidityPoolURL` 是否正確設定且可達
   - 確認 `SecretKey` 簽名

3. **手動重試**
   - 修正問題後透過後台重試
   - 注意 2 分鐘 Redis 鎖
