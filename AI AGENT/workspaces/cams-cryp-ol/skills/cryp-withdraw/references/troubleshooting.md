# 提幣排查

## 狀態流轉

```
API 請求 → withdraw(status=0) → Cron RunWithdraw → 取私鑰 → 簽署 → 廣播 → withdraw(status=1/2)
                                                                                    │
                                                                    status=1 → 通知商戶(等確認) → ListenBlock 偵測 → TransactionConfirm → TransactionNotify
                                                                    status=2 → 通知商戶(失敗)
```

## 常見問題

### 提幣請求回傳 transfer_id 已存在

1. 確認 `transfer_id` 是否重複提交
   ```sql
   SELECT * FROM withdraw WHERE transfer_id = 'uuid...';
   ```
2. 非同步提幣使用 `transfer_id` 做冪等性檢查
3. 若確實需要重新提幣，需使用新的 `transfer_id`

### 提幣停留在 status=0（佇列中）

1. 確認 Cron `RunWithdraw` 是否正常執行
   - 查 ELK 日誌 `task_name=RunWithdraw`
   - 若日誌顯示 `no withdraw need to process` 表示佇列為空

2. 確認查詢條件
   ```sql
   SELECT * FROM withdraw WHERE transfer_id != '' AND status = 0;
   ```

3. 確認 Keychain 服務是否正常
   - 查日誌 `get private key error` 或 `decrypt private key error`
   - Keychain 無法回應會導致提幣失敗

### 提幣失敗（status=2）

查看日誌中 `run withdraw error` 的具體錯誤：

#### 餘額不足
- 日誌：`ErrBalanceInsufficient`
- 檢查 from_address 的鏈上餘額是否足夠（含 gas 費用）
- 主幣提幣：需 amount + gas fee
- 代幣提幣：需 amount（代幣）+ gas fee（ETH）

#### 幣種不存在
- 日誌：`ErrCryptoNotFound`
- 確認 `tokens` 表中是否有對應的 `crypto_type`

#### Nonce 問題
- 日誌：`nonce too low` 或 `already known`
- 系統會自動重試一次
- 若仍失敗，檢查 `address.nonce` 與鏈上 nonce 是否一致
  ```sql
  SELECT address, nonce FROM address WHERE address = '0x...';
  ```

#### 簽署錯誤
- 日誌：`sign transaction error` 或 `make sign txn error`
- 確認私鑰是否正確（Keychain 回傳）
- 確認代幣的 `contract_addr` 是否正確

#### 廣播錯誤
- 日誌：`send transaction error`
- 確認節點是否正常
- 確認 gas_price 是否過低（可能被節點拒絕）

### 提幣成功但 has_chain=0（未上鏈）

1. 等待 5 分鐘以上（系統跳過近 5 分鐘的記錄）
2. 確認 `CheckWithdraw` 排程是否正常
   - 查日誌 `task_name=CheckWithdraw`
3. 在鏈上查詢 tx_hash 狀態
   - Pending：交易在 mempool 中，等待打包
   - 找不到：交易可能已遺失，系統會通知商戶重試
4. 檢查 gas_price 是否過低導致交易長時間 pending
   ```sql
   SELECT tx_hash, nonce, amount FROM withdraw WHERE has_chain = 0 AND has_retried = 0;
   ```

### Nonce 卡住（交易一直 pending）

1. 查看地址的 nonce 狀態
   ```sql
   SELECT address, nonce FROM address WHERE address = '0x...';
   SELECT nonce, status, tx_hash FROM withdraw WHERE from_address = '0x...' ORDER BY nonce DESC LIMIT 10;
   ```

2. 比較鏈上 nonce
   - 鏈上 pending nonce > DB nonce：有未記錄的交易
   - 鏈上 pending nonce < DB nonce：有交易被 drop

3. 若 nonce 有間隙（gap），後續交易都會卡住
   - 需要用缺失的 nonce 發送一筆交易來填補

### 提幣重試機制

當交易鏈上遺失時（`IsPendingTx` 回傳 NotFound）：
1. 系統向商戶發送 `TxStatusRetryWithdraw` 通知
2. 更新 `has_retried=1, status=2`
3. 商戶需重新發起提幣請求（帶 `tx_id` 為原始 tx_hash）
4. 系統檢查原交易是否仍 pending，若否則用新 nonce 重新簽署

### 提幣地址驗證失敗

- 日誌：`create withdraw ValidAddress fail`
- `from_address` 或 `to_address` 不是有效的 ETH 地址格式
- ETH 地址格式：0x 開頭 + 40 位十六進位字元

### 商戶提幣通知未收到

1. 確認 `withdrawNotify` 是否執行
   - 查日誌 `create withdraw notify`
2. 確認商戶通知 URL 是否正確
   - 根據 `merchant_type` 取得 URL
3. 注意：成功上鏈的提幣，通知時 status=0（等確認），不是直接通知成功
   - 最終成功/失敗由 `TransactionNotify` 在確認後通知
