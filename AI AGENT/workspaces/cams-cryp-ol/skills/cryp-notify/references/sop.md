# 通知與告警問題處理

> **相關 Spec 參考**
> - [02-transaction-flow.md](../specs/02-transaction-flow.md) - 通知狀態碼定義
> - [05-integrations.md](../specs/05-integrations.md) - 商戶通知機制與排程任務
> - [troubleshooting/03-notify-alert.md](../specs/troubleshooting/03-notify-alert.md) - 通知排查速查

> **多鏈架構說明**
> cryp 是多鏈架構，每條鏈的通知機制相同，但 ELK index 不同。

> **ELK 查詢指引**
> - ELK Index：`cryp-{chain.code}`（如 `cryp-eth`、`cryp-tron`、`cryp-bsc`）
> - 需先確認是哪條鏈，再查對應的 index

## 適用情境

交易通知未送達、通知狀態異常、風控通知問題、提幣通知未觸發。

---

## 情境一：交易通知未發送（notify_status=1 卡住）

### 排查步驟

1. **確認 TransactionNotify 排程**
   ```sql
   SELECT COUNT(*) FROM transaction WHERE notify_status = 1;
   ```
   - 查 ELK `task_name=TransactionNotify`

2. **確認通知 URL 取得是否成功**
   - 查日誌 `create transaction notify(get notify host) error`
   - 確認地址的 merchant_type 設定正確
   ```sql
   SELECT address, merchant_type FROM address WHERE address = '交易地址';
   ```

3. **確認 HTTP 回調是否成功**
   - 查日誌中 `curl` 欄位，可複製直接測試
   - 商戶回調 URL 返回非 200 會標記為失敗

---

## 情境二：通知狀態為 3（失敗）

### 排查步驟

1. **查看具體錯誤**
   - ELK 搜尋 `tx_hash` + `create transaction notify error`

2. **常見失敗原因**
   - 商戶服務不可達（timeout、connection refused）
   - 商戶回傳非預期 status code
   - 網路問題

3. **注意：系統不會自動重試失敗的通知**

---

## 情境三：notify_status 停在 0（未處理）

### 排查步驟

- notify_status=0 表示交易尚未被 TransactionConfirm 處理
- 交易仍在 status=0（待確認）
- 只有 TransactionConfirm 將交易標記為成功/失敗後，才會更新 notify_status=1

---

## 情境四：提幣通知未觸發

### 排查步驟

1. **確認 withdrawNotify goroutine**
   - 查日誌 `create withdraw notify`（有 30 秒超時）

2. **確認 merchant_type 對應通知 URL**
   - 查日誌 `merchant type not found`

3. **注意通知時機**
   - 提幣廣播成功 → 通知 status=0（等確認），非最終結果
   - 最終成功/失敗由 TransactionNotify 在鏈上確認後通知
   - 提幣廣播失敗 → 通知 status=2（失敗）

---

## 情境五：CheckWithdraw 重試通知

### 排查步驟

1. **查詢可能需重試的提幣**
   ```sql
   SELECT * FROM withdraw
   WHERE has_chain = 0 AND has_retried = 0
   AND create_time BETWEEN UNIX_TIMESTAMP(NOW() - INTERVAL 7 DAY) AND UNIX_TIMESTAMP(NOW())
   AND UNIX_TIMESTAMP(NOW()) - create_time > 300;
   ```

2. **系統行為**
   - 發送 `TxStatusRetryWithdraw` 通知
   - 更新 has_retried=1, status=2
   - 商戶需重新發起提幣請求

3. **查看通知是否成功**
   - 查日誌 `check withdraw create txn notify`

---

## 情境六：風控通知問題

### 排查步驟

1. **注意：RiskControlNotify 排程可能未在 SetupCron 中註冊**

2. **查詢待處理風控交易**
   ```sql
   SELECT * FROM transaction WHERE risk_control_status = 0;
   ```

3. **風控邏輯**
   - 交易已 status=1 或 status=2 → 直接標記 risk_control_status=2（不需通知）
   - 交易待確認 → 發送通知
