---
name: cryp-withdraw
description: 當操作者提到 cryp提幣、withdraw、提現、出金、nonce、卡住、has_chain、未上鏈、transfer_id、餘額不足、tx_type=2 時觸發
metadata:
  openclaw:
    emoji: "📤"
    requires:
      bins: ["mcporter"]
---

# CRYP 提幣問題診斷

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

## 前置知識

- 非同步提幣流程：API → withdraw 表 (status=0) → Cron RunWithdraw 每分鐘處理 → Keychain 取私鑰 → 簽署 → 廣播
- withdraw.status：`0`=處理中, `1`=成功(已廣播), `2`=失敗
- withdraw.has_chain：`0`=未上鏈, `1`=已上鏈
- Nonce 管理（EVM 鏈）：取 max(鏈上 PendingNonceAt, DB withdraw 最大成功 nonce+1)
- CheckWithdraw：跳過建立不到 5 分鐘的記錄，檢查最近 7 天
- 重試機制：系統發送 TxStatusRetryWithdraw 通知，商戶需帶 tx_id（原 tx_hash）重新提交
- 常用搜尋欄位：`transfer_id`、`tx_hash`、`from_address`、`nonce`、`task_name`

## 診斷流程

### 情境一：提幣請求 transfer_id 已存在

- **請 RD 查詢 DB**：`SELECT * FROM withdraw WHERE transfer_id = 'uuid...';`
- status=0 → 在佇列中等待處理，不可重複提交
- status=1 → 已成功廣播
- status=2 → 已失敗，需使用新 transfer_id；若要重試帶 tx_id 參數
- 無記錄 → 可能 API 端驗證失敗，查 ELK 錯誤 log：
  ```
  cams-mcp.search_logs --index cryp-{chain} --query "transfer_id:{id}" --level error --output json
  ```

### 情境二：提幣停留在 status=0

查 RunWithdraw 排程狀態：
```
cams-mcp.search_logs --index cryp-{chain} --query "task_name:RunWithdraw" --size 20 --output json
```
- `no withdraw need to process` → **請 RD 查詢 DB**：`SELECT * FROM withdraw WHERE transfer_id != '' AND status = 0;`
- `get private key error` → Keychain 服務異常，確認 Keychain 服務、網路、merchant_type
- `decrypt private key error` → RSA 解密失敗，聯繫 Keychain 團隊
- 無 RunWithdraw 日誌 → Cron Worker 可能未啟動或排程未註冊

### 情境三：提幣失敗（status=2）

查錯誤訊息：
```
cams-mcp.search_logs --index cryp-{chain} --query "run withdraw error" --level error --output json
```

| 錯誤類型 | 處理方式 |
|---------|---------|
| ErrBalanceInsufficient | from_address 餘額不足，主幣需 amount+gas fee，代幣需 amount(代幣)+gas fee(主幣) |
| ErrCryptoNotFound | 幣種不在 tokens 表，需透過 API 建立 |
| nonce too low / already known | Nonce 衝突，系統已自動重試一次，若仍失敗進入情境五 |
| sign transaction error | Keychain 私鑰或 contract_addr 問題 |
| send transaction error | 節點異常或 gas_price 過低被拒 |
| ErrTransactionDuplicate | Nonce 重複，進入情境五 |
| ValidAddress fail | 地址格式錯誤（ETH: 0x + 40 位 hex） |

### 情境四：提幣成功但 has_chain=0（未上鏈）

收集：tx_hash、create_time、鏈上交易狀態

1. 建立不到 5 分鐘 → 系統會跳過，請等待
2. 超過 5 分鐘：
   ```
   cams-mcp.search_logs --index cryp-{chain} --query "task_name:CheckWithdraw" --output json
   ```
   - 鏈上 pending → gas_price 過低，礦工未優先處理
   - 鏈上 NotFound → 系統自動發 TxStatusRetryWithdraw 通知，更新 has_retried=1, status=2
   - 鏈上已確認但 has_chain=0 → ListenBlock 尚未掃到該區塊

### 情境五：Nonce 卡住（EVM 鏈專屬）

收集：from_address、DB address.nonce、鏈上 PendingNonceAt

- **請 RD 查詢 DB**：`SELECT address, nonce FROM address WHERE address = '0x...';`
- 鏈上 nonce > DB nonce → 有未記錄的鏈上交易，需手動更新 address.nonce
- 鏈上 nonce < DB nonce → 有交易被 drop，**請 RD 查詢 DB**：`SELECT nonce, status, tx_hash FROM withdraw WHERE from_address = '0x...' ORDER BY nonce DESC LIMIT 10;`
- nonce 有間隙 → 用缺失 nonce 發送 0 ETH 自轉填補
- nonce 一致但仍 pending → gas_price 過低，用相同 nonce + 更高 gas_price 發替代交易
