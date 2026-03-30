# 充值排查

## 狀態流轉

```
鏈上交易 → ListenBlock 偵測 → transaction(status=0) → TransactionConfirm → transaction(status=1/2, notify_status=1) → TransactionNotify → notify_status=2
```

## 常見問題

### 充值交易未入帳

1. 確認區塊高度是否追上
   ```sql
   SELECT * FROM block_height;
   ```
   - 若 `block_height` 遠小於鏈上最新高度，表示刷塊進度落後
   - 查 ELK 日誌 `task_name=ListenBlock` 是否有錯誤

2. 確認該交易的區塊高度是否已被掃描
   - 交易所在區塊 > DB block_height → 尚未掃到，等待即可
   - 交易所在區塊 < DB block_height → 可能被遺漏

3. 確認地址是否在 `address` 表中
   ```sql
   SELECT * FROM address WHERE address = '目標地址';
   ```
   - 若不存在，系統不會認為是充值交易

4. 確認交易是否為有效交易
   - 主幣：`tx.Value > 0` 且 `tx.To != nil`
   - 代幣：合約地址在 `tokens` 表中且 Transfer 事件金額 > 0

5. 若確認被遺漏，手動補錄
   - 呼叫 API `POST /transaction/block-number`，傳入區塊號碼手動重新抓取

### 充值交易長時間停留在 status=0（待確認）

1. 確認鏈上交易是否已超過確認數
   - 確認數配置：dev=12, local=32
   - 交易 block_height + confirmCount <= 最新區塊高度才會被確認

2. 確認 TransactionConfirm 排程是否正常
   - 查 ELK 日誌 `task_name=TransactionConfirm`
   - 每次最多處理 20 筆待確認交易

3. 確認 receipt 是否能正常取得
   - 若節點有問題，receipt 可能取不到
   - 查日誌是否有 `get transaction receipt error`

### 充值金額不正確

1. 主幣金額
   - 檢查 `tokens` 表中 ETH 的 `decimals` 是否為 18
   - 金額轉換：`swap.BaseToNativeFromBigInt(tx.Value(), 18)`

2. 代幣金額
   - 檢查 `tokens` 表中該代幣的 `decimals` 和 `contract_abi` 是否正確
   - 代幣金額從 Transfer 事件 log 的 data 欄位解析

### 區塊高度不增長

1. 查看 `ListenBlock` 是否正在執行
   - 查日誌 `task is running` 或 `task will be start`

2. 查看是否有 watchdog 觸發
   - 日誌：`DB block height has not increased for 60 seconds, canceling context`
   - 表示 60 秒內高度沒變，context 被取消

3. 查看節點是否正常
   - 日誌：`failover error`、`節點切換`
   - 查看 `check new block error`

4. 查看是否有大量失敗區塊
   - 日誌：`get block by number error`
   - 失敗區塊會進入重試佇列

5. 清除區塊高度重新開始
   - 呼叫 API `DELETE /block-height`
   - 系統會從最新區塊重新開始追蹤

### 代幣充值未偵測到

1. 確認 `tokens` 表中該代幣是否存在
   ```sql
   SELECT * FROM tokens WHERE crypto_type = 'USDT';
   ```

2. 確認合約地址是否正確
   ```sql
   SELECT contract_addr FROM tokens WHERE crypto_type = 'USDT';
   ```

3. 確認合約 ABI 是否包含 Transfer 事件

4. 確認 `ethclient.GetTransactionByToken` 是否能取到 log
   - ERC-721 交易（topics > 3）會被過濾掉

### 重複充值記錄

- 系統有去重機制：`IsNewTxn` 會檢查 tx_hash 是否已存在於 `transaction` 表
- 若出現重複，檢查是否有多個 worker 同時處理同一區塊
- `workerCount` 配置為 1 時不應出現此問題
