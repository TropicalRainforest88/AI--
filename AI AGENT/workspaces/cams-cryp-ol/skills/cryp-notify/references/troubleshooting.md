# 通知與告警排查

## 通知類型

| 通知類型 | 排程任務 | 觸發條件 | 通知對象 |
|----------|----------|----------|----------|
| TransactionNotify | Cron TransactionNotify | `notify_status = 1 (Pending)` | 商戶 |
| RiskControlNotify | Cron RiskControlNotify | `risk_control_status = 0 (Unprocessed)` | 商戶 |
| WithdrawNotify | 提幣完成後即時觸發 | 非同步提幣成功或失敗 | 商戶 |
| CheckWithdraw Notify | Cron CheckWithdraw | 提幣交易鏈上遺失 | 商戶 |

## 狀態流轉

### TransactionNotify
```
交易確認(TransactionConfirm) → notify_status=1(Pending) → TransactionNotify → notify_status=2(成功)/3(失敗)
```

### RiskControlNotify
```
交易入庫 → risk_control_status=0(未處理) → RiskControlNotify:
  - 若交易已成功/失敗 → 直接標記 risk_control_status=2(成功)
  - 若交易待確認 → 發送通知 → 更新 risk_control_status
```

### WithdrawNotify
```
RunWithdraw 完成 → 更新 withdraw 記錄 → go withdrawNotify():
  - 成功上鏈 → 通知 status=0 (等確認)
  - 廣播失敗 → 通知 status=2 (失敗)
```

## 常見問題

### 交易通知未發送（notify_status 停在 1）

1. 確認 TransactionNotify 排程是否正常
   ```sql
   SELECT COUNT(*) FROM transaction WHERE notify_status = 1;
   ```
   - 查 ELK 日誌 `task_name=TransactionNotify`

2. 確認通知 URL 是否取得成功
   - 查日誌 `create transaction notify(get notify host) error`
   - 確認 `address` 表中的地址有對應的 `merchant_type`
   ```sql
   SELECT a.address, a.merchant_type FROM address a WHERE a.address = '交易地址';
   ```

3. 確認 HTTP 回調是否成功
   - 查日誌中的 `curl` 欄位，可直接複製執行測試
   - 查看 `notify_result` 狀態碼

4. 確認商戶服務是否正常
   - 商戶回調 URL 返回非 200 會標記為失敗

### 通知狀態為 3（失敗）

1. 查看具體錯誤
   - ELK 搜尋 `tx_hash` + `create transaction notify error`

2. 常見失敗原因：
   - 商戶服務不可達（timeout、connection refused）
   - 商戶回傳非預期的 status code
   - 網路問題

3. 目前系統不會自動重試失敗的通知
   - 需確認是否有人工介入機制

### notify_status 停在 0（未處理）

- `notify_status = 0` 表示交易尚未被 TransactionConfirm 處理
- 交易仍在 `status = 0`（待確認）狀態
- 只有 TransactionConfirm 將交易標記為成功/失敗後，才會更新 `notify_status = 1`

### 風控通知問題

1. 確認 RiskControlNotify 排程是否執行
   - 注意：此排程目前未在 `cron/init.go` 的 `SetupCron` 中註冊
   - [TODO: 需確認] RiskControlNotify 是否由其他方式觸發

2. 查詢待處理的風控交易
   ```sql
   SELECT * FROM transaction WHERE risk_control_status = 0;
   ```

3. 風控通知邏輯
   - 若交易已 `status=1(成功)` 或 `status=2(失敗)` → 直接標記 `risk_control_status=2`
   - 否則發送通知給商戶

### 提幣通知未觸發

1. WithdrawNotify 是在提幣完成後以 goroutine 異步觸發
   - 查日誌 `create withdraw notify`
   - 有 30 秒超時

2. 確認 merchant_type 對應的通知 URL 是否存在
   - 查日誌 `merchant type not found`

3. 注意通知時機
   - 提幣廣播成功 → 通知 status=0（等確認），不是最終結果
   - 最終的成功/失敗由 TransactionNotify 在鏈上確認後通知
   - 提幣廣播失敗 → 通知 status=2（失敗）

### CheckWithdraw 重試通知

當提幣交易在鏈上找不到時（非 pending、非已上鏈）：

1. 查詢可能需要重試的提幣
   ```sql
   SELECT * FROM withdraw
   WHERE has_chain = 0
   AND has_retried = 0
   AND create_time BETWEEN UNIX_TIMESTAMP(NOW() - INTERVAL 7 DAY) AND UNIX_TIMESTAMP(NOW())
   AND UNIX_TIMESTAMP(NOW()) - create_time > 300;
   ```

2. 系統行為
   - 發送 `TxStatusRetryWithdraw` 通知給商戶
   - 更新 `has_retried=1, status=2`
   - 商戶需重新發起提幣請求

3. 查看通知是否成功
   - 查日誌 `check withdraw create txn notify`

## 節點相關告警

### 節點 Failover

- 日誌關鍵字：`failover error`、`failover retry`、`節點切換`
- 觸發條件：RPC 呼叫失敗且錯誤匹配重試關鍵字
- 觀察：短時間大量 failover 表示所有節點都不穩定

### 所有節點 Disable

- 日誌：`節點功能測試失敗, 已自動disable此節點`
- 當所有節點都 disable 時，系統會嘗試使用 disable 的節點
- 需儘快在 RabbitMQ Admin 中新增或修復節點

### 節點切換失敗

- 查看 `use node` 欄位確認當前使用的節點
- 查看 `trouble node` 確認問題節點
- 確認 jsonConfigV2 中是否有可用節點

## Cron Panic 告警

- 所有排程任務都有 panic recovery
- 日誌關鍵字：`cron panic`
- 包含 `error_type`、`job_name` 欄位
- Panic 後該任務會停止，等下一分鐘重新啟動
