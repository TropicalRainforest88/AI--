# 提幣問題處理

> **相關 Spec 參考**
> - [03-withdraw-flow.md](../specs/03-withdraw-flow.md) - 提幣完整流程、Nonce 管理、私鑰管理
> - [02-transaction-flow.md](../specs/02-transaction-flow.md) - 交易狀態碼與確認流程
> - [troubleshooting/02-withdraw.md](../specs/troubleshooting/02-withdraw.md) - 提幣排查速查

> **多鏈架構說明**
> cryp 是多鏈架構，每條鏈有獨立的 cryp 服務。提幣流程相同但鏈特性不同（Nonce 機制為 EVM 鏈特性、Gas 機制、地址格式等）。以下以 ETH 為範例說明。

> **ELK 查詢指引**
> - ELK Index：`cryp-{chain.code}`（如 `cryp-eth`、`cryp-tron`、`cryp-bsc`）
> - 需先確認是哪條鏈，再查對應的 index

## 適用情境

提幣請求被拒、提幣卡住 status=0、提幣失敗 status=2、提幣成功但未上鏈、Nonce 卡住。

---

## 情境一：提幣請求 transfer_id 已存在

### 排查步驟

1. **確認 transfer_id 是否重複提交**
   ```sql
   SELECT * FROM withdraw WHERE transfer_id = 'uuid...';
   ```
2. 非同步提幣用 transfer_id 做冪等性檢查
3. 若需重新提幣 → 使用新的 transfer_id

---

## 情境二：提幣停留在 status=0（佇列中）

### 排查步驟

1. **確認 RunWithdraw 排程是否執行**
   - 查 ELK `task_name=RunWithdraw`
   - `no withdraw need to process` 表示佇列為空

2. **確認 DB 中確實有待處理記錄**
   ```sql
   SELECT * FROM withdraw WHERE transfer_id != '' AND status = 0;
   ```

3. **確認 Keychain 服務是否正常**
   - 查日誌 `get private key error` 或 `decrypt private key error`

---

## 情境三：提幣失敗（status=2）

### 排查步驟

查 ELK `run withdraw error` 的具體錯誤：

| 錯誤 | 說明 | 處理 |
|------|------|------|
| `ErrBalanceInsufficient` | 餘額不足 | 主幣：amount + gas fee；代幣：amount（代幣）+ gas fee（ETH） |
| `ErrCryptoNotFound` | 幣種不存在 | 確認 tokens 表有對應 crypto_type |
| `nonce too low` / `already known` | Nonce 問題 | 系統自動重試一次；若仍失敗見情境五 |
| `sign transaction error` | 簽署錯誤 | 確認 Keychain 私鑰是否正確、代幣 contract_addr 是否正確 |
| `send transaction error` | 廣播錯誤 | 確認節點是否正常、gas_price 是否過低 |

---

## 情境四：提幣成功但 has_chain=0（未上鏈）

### 排查步驟

1. **等待至少 5 分鐘**（系統跳過近 5 分鐘的記錄）

2. **確認 CheckWithdraw 排程**
   - 查 ELK `task_name=CheckWithdraw`

3. **在鏈上查詢 tx_hash**
   - Pending → 交易在 mempool，等待打包；可能 gas_price 過低
   - 找不到 → 交易遺失，系統會發送 `TxStatusRetryWithdraw` 通知商戶
   ```sql
   SELECT tx_hash, nonce, amount FROM withdraw WHERE has_chain = 0 AND has_retried = 0;
   ```

---

## 情境五：Nonce 卡住

### 排查步驟

1. **查看地址 nonce 狀態**
   ```sql
   SELECT address, nonce FROM address WHERE address = '0x...';
   SELECT nonce, status, tx_hash FROM withdraw WHERE from_address = '0x...' ORDER BY nonce DESC LIMIT 10;
   ```

2. **比較鏈上 nonce**
   - 鏈上 pending nonce > DB nonce → 有未記錄的交易
   - 鏈上 pending nonce < DB nonce → 有交易被 drop

3. **若 nonce 有間隙 (gap)**
   - 後續所有交易都會卡住
   - 需用缺失的 nonce 發送一筆交易來填補

---

## 情境六：提幣地址驗證失敗

### 排查步驟

- 日誌：`create withdraw ValidAddress fail`
- ETH 地址格式：`0x` 開頭 + 40 位十六進位字元
- 確認 from_address 和 to_address 格式是否正確
