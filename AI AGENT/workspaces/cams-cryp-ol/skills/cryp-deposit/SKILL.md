---
name: cryp-deposit
description: 當操作者提到 cryp充值、deposit、入帳、未偵測到、區塊高度、block height、刷塊、tx_type=1 時觸發
metadata:
  openclaw:
    emoji: "📥"
    requires:
      bins: ["mcporter"]
---

# CRYP 充值問題診斷

## MCP 伺服器
- 名稱: cams-mcp
- 工具: search_logs, search_by_trace, get_log_context, get_error_summary, get_log_trend, list_indices, get_version
- **所有指令加 `--output json`**

| 指令 | 用途 | 關鍵參數 |
|------|------|---------|
| search_logs | 搜尋日誌 | index, query, size, level, from_time, to_time |
| search_by_trace | 用 trace_id 追蹤 | index, trace_id |
| get_log_context | 取得日誌前後文 | index, log_id, before, after |
| get_error_summary | 錯誤統計 | index, field, from_time, to_time |
| get_log_trend | 日誌趨勢 | index, interval, from_time, to_time |

## 鏈別 Index 對照表

| Index | 鏈 |
|-------|-----|
| cryp-polygon | Polygon |
| cryp-bsc | BSC |
| cryp-eth | Ethereum |
| cryp-tron | TRON |
| cryp-sol-v2 | Solana |
| cryp-arbitrum | Arbitrum |
| cryp-optimism | Optimism |
| cryp-base | Base |
| cryp-avax-cchain | Avalanche |
| cryp-ton | TON |
| cryp-btc | Bitcoin |
| cryp-dot | Polkadot |
| cryp-sui | Sui |
| cryp-sonic | Sonic |
| cryp-kaspa | Kaspa |

> **重要**：每次查詢前必須先問操作者是哪條鏈，再使用對應的 `cryp-{chain.code}` index。

## 核心原則：鏈上為真 (Chain is Truth)

當使用者提供鏈上資訊（金額、tx_hash、交易狀態等），**不得僅靠系統日誌駁回使用者的鏈上觀察**。必須先驗證鏈上實際數據，再與系統記錄比對。鏈上數據為 ground truth，系統記錄與鏈上不一致本身就是需要報告的異常。

## 前置知識

- 充值是被動偵測：Cron `ListenBlock` 每分鐘掃區塊，偵測系統地址的入帳交易
- 每次最多處理 6 個區塊（ListenBlock），20 筆確認（TransactionConfirm）
- 交易狀態：`0`=待確認, `1`=成功, `2`=失敗
- 確認數依鏈和環境不同（如 ETH: dev=12, local=32）
- Watchdog：60 秒內 DB 高度未增加 → 取消 context
- 常用搜尋欄位：`tx_hash`、`to_address`、`from_address`、`block_height`、`task_name`、`trace_id`

## 診斷流程

### 情境一：充值交易未入帳

收集資訊（任一即可開始）：tx_hash 或 to_address + 區塊高度

1. **請 RD 查詢 DB**：`SELECT * FROM block_height;` 取得目前刷塊進度
2. 若交易區塊 > DB block_height → 系統尚未掃到，查 ELK ListenBlock 是否有錯誤：
   ```
   cams-mcp.search_logs --index cryp-{chain} --query "task_name:ListenBlock" --level error --output json
   ```
3. 若交易區塊 <= DB block_height（已掃過但未入帳）：
   - **請 RD 查詢 DB**：`SELECT * FROM address WHERE address = '目標地址';` 確認地址是否在系統中
   - 地址不存在 → 該地址不在系統管理中，需先透過 API 加入
   - **請 RD 查詢 DB**：`SELECT * FROM transaction WHERE tx_hash = '0x...';`
   - 有記錄 → 依 status 進入情境二
   - 無記錄 → 交易被遺漏，建議呼叫 `POST /transaction/block-number` 傳入區塊號碼手動重新抓取

### 情境二：交易停留在 status=0（待確認）

收集：tx_hash、交易 block_height、鏈上最新區塊高度

1. 計算：交易 block_height + confirmCount vs 最新高度
2. 未達確認數 → 請等待
3. 已超過確認數但仍 status=0 → 查 TransactionConfirm：
   ```
   cams-mcp.search_logs --index cryp-{chain} --query "task_name:TransactionConfirm" --level error --output json
   ```
4. 常見原因：節點無法取得 receipt（查 `get transaction receipt error`）
5. 每次最多處理 20 筆，可能排隊中。**請 RD 查詢 DB**：`SELECT COUNT(*) FROM transaction WHERE status = 0;`

### 情境三：充值金額不正確

**若使用者提供了鏈上查詢結果（如區塊瀏覽器顯示的金額），先確認：**

1. 用 tx_hash 查 cryp-* index，取系統記錄的 amount
2. 與使用者提供的鏈上金額比對
3. 不一致時，優先調查系統解析邏輯（decimals、合約 ABI），不得假設使用者看錯

**系統端排查：**
- **請 RD 查詢 DB**：`SELECT decimals, contract_abi FROM tokens WHERE crypto_type = '代幣名稱';`
- 主幣：確認 decimals 是否為 18
- 代幣：金額從 Transfer 事件 log data 解析，decimals 錯誤會導致金額偏差

### 情境四：代幣充值未偵測到

依序檢查（皆需 **請 RD 查詢 DB**）：
1. 代幣是否已註冊：`SELECT * FROM tokens WHERE crypto_type = '代幣名稱';`
2. 合約地址是否正確
3. ABI 是否包含 Transfer 事件
4. ERC-721（topics > 3）會被系統過濾，NFT 轉帳為正常行為

### 情境五：區塊高度不增長

查 ListenBlock 最近日誌：
```
cams-mcp.search_logs --index cryp-{chain} --query "task_name:ListenBlock" --size 20 --output json
```
- `task is running` → 正常執行中
- watchdog 觸發 → 60 秒內高度未增加，可能節點回應慢
- `failover error` / `check new block error` → 節點異常，參考 cryp-node-block skill
- `get block by number error` → 部分區塊抓取失敗，`RetrySyncTxnByFailBlockNum` 每分鐘自動重試
- 緊急處理：呼叫 `DELETE /block-height` 從最新區塊重新追蹤（注意：重置期間的區塊可能遺漏交易）
