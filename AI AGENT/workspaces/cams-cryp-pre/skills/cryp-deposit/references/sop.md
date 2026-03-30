# 充值問題處理

> **相關 Spec 參考**
> - [02-transaction-flow.md](../specs/02-transaction-flow.md) - 交易生命週期與狀態碼
> - [05-integrations.md](../specs/05-integrations.md) - 節點 RPC 方法與排程任務
> - [troubleshooting/01-deposit.md](../specs/troubleshooting/01-deposit.md) - 充值排查速查

> **多鏈架構說明**
> cryp 是多鏈架構，每條鏈有獨立的 cryp 服務（如 cryp-eth、cryp-tron、cryp-bsc）。充值流程相同但鏈特性可能不同（確認數、Gas 機制、地址格式等）。以下以 ETH 為範例說明。

> **ELK 查詢指引**
> - ELK Index：`cryp-{chain.code}`（如 `cryp-eth`、`cryp-tron`、`cryp-bsc`）
> - 需先確認是哪條鏈，再查對應的 index

## 適用情境

充值未入帳、充值長時間待確認、充值金額不正確、代幣充值未偵測、區塊高度不增長。

---

## 情境一：充值交易未入帳

### 排查步驟

1. **確認區塊高度是否追上**
   ```sql
   SELECT * FROM block_height;
   ```
   - 若 block_height 遠小於鏈上最新高度 → 刷塊進度落後，查 ELK `task_name=ListenBlock`

2. **確認交易所在區塊是否已被掃描**
   - 交易區塊 > DB block_height → 尚未掃到，等待即可
   - 交易區塊 < DB block_height → 可能遺漏

3. **確認地址是否在 address 表中**
   ```sql
   SELECT * FROM address WHERE address = '目標地址';
   ```
   - 若不存在 → 系統不會識別為充值

4. **確認交易是否為有效交易**
   - 主幣：`tx.Value > 0` 且 `tx.To != nil`
   - 代幣：合約地址在 tokens 表中且 Transfer 事件金額 > 0

5. **手動補錄遺漏的交易**
   - 呼叫 API `POST /transaction/block-number`，傳入區塊號碼重新抓取

---

## 情境二：充值長時間停留在 status=0（待確認）

### 排查步驟

1. **確認鏈上確認數是否足夠**
   - 確認數配置：dev=12, local=32
   - 條件：交易 block_height + confirmCount <= 最新區塊高度

2. **確認 TransactionConfirm 排程是否正常**
   - 查 ELK `task_name=TransactionConfirm`
   - 每次最多處理 20 筆待確認交易

3. **確認 receipt 是否能正常取得**
   - 查日誌是否有 `get transaction receipt error`
   - 節點問題會導致 receipt 取不到

---

## 情境三：充值金額不正確

### 排查步驟

1. **主幣金額**
   - 檢查 tokens 表中 ETH 的 `decimals` 是否為 18

2. **代幣金額**
   - 檢查 tokens 表中該代幣的 `decimals` 和 `contract_abi` 是否正確
   - 代幣金額從 Transfer 事件 log 的 data 欄位解析

---

## 情境四：代幣充值未偵測到

### 排查步驟

1. **確認代幣是否已註冊**
   ```sql
   SELECT * FROM tokens WHERE crypto_type = '代幣名稱';
   ```

2. **確認合約地址是否正確**
   ```sql
   SELECT contract_addr FROM tokens WHERE crypto_type = '代幣名稱';
   ```

3. **確認合約 ABI 是否包含 Transfer 事件**

4. **注意 ERC-721 過濾**
   - topics > 3 的事件會被過濾掉

---

## 情境五：區塊高度不增長

### 排查步驟

1. **確認 ListenBlock 是否在執行**
   - 查日誌 `task is running` 或 `task will be start`

2. **確認是否有 watchdog 觸發**
   - 日誌：`DB block height has not increased for 60 seconds, canceling context`

3. **確認節點狀態**
   - 查日誌 `failover error`、`check new block error`

4. **確認是否有大量失敗區塊**
   - 查日誌 `get block by number error`
   - 失敗區塊進入重試佇列（RetrySyncTxnByFailBlockNum）

5. **緊急處理：重置區塊高度**
   - 呼叫 API `DELETE /block-height`
   - 系統會從最新區塊重新開始追蹤
