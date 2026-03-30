---
name: cams-withdraw
description: 當使用者提到提現、withdraw、出金、提幣、WD開頭訂單、提現卡住、提現失敗、餘額不足、鏈上轉帳失敗時觸發
metadata:
  openclaw:
    emoji: "📤"
    requires:
      bins: ["mcporter"]
---

# CAMS 提現問題診斷

## MCP 伺服器
- 名稱: cams-mcp
- 工具: search_logs, search_by_trace, get_log_context, get_error_summary, get_log_trend, list_indices, get_version
- **所有指令加 `--output json`**

## 工具參數速查
| 指令 | 關鍵參數 |
|------|---------|
| search_logs | index, query, size, level, from_time, to_time |
| search_by_trace | index, trace_id |
| get_log_context | index, log_id, before, after |
| get_error_summary | index, field, from_time, to_time |

> `from_time`/`to_time` 用 ISO 8601 格式，結果逆序。查詢前確認 `created_at`，起始往前 2-5 分鐘。

## 相關 Index
| Index | 用途 |
|-------|------|
| cams-api | API 請求日誌 |
| cams-job | 後台任務（提幣、轉帳、通知） |

### 鏈服務（cryp-*）
| Index | 鏈 |
|-------|-----|
| cryp-polygon | Polygon (MATIC) |
| cryp-bsc | BNB Smart Chain |
| cryp-eth | Ethereum |
| cryp-tron | TRON |
| cryp-sol-v2 | Solana |
| cryp-arbitrum | Arbitrum |
| cryp-optimism | Optimism |
| cryp-base | Base |
| cryp-avax-cchain | Avalanche C-Chain |
| cryp-ton | TON |
| cryp-btc | Bitcoin |
| cryp-dot, cryp-sui, cryp-sonic, cryp-kaspa | 其他鏈 |

### bankcode → index 映射
| bankcode 關鍵字 | 對應 index |
|----------------|-----------|
| POLYGONUSDT | cryp-polygon |
| BNBUSDT, BSCUSDT | cryp-bsc |
| ETHUSDT, ERC20 | cryp-eth |
| TRCUSDT, TRC20 | cryp-tron |
| SOLUSDT | cryp-sol-v2 |

## 狀態碼速查

### WD Order Status 流轉
```
商戶API → Pending(0) → [AuditPending(13)?] → CreateTransfer(1) → TransferCreated(3) → PreTransfer(4) → ProcessTransfer(5) → Confirming(7) → Success(8)/Failed(9)
                                                                                         ↑                       |
                                                                                         └── WaitRetryTransfer(6) ←┘
```
0=Pending, 1=CreateTransfer, 2=CreateTransferFail, 3=TransferCreated, 4=PreTransfer, 5=ProcessTransfer, 6=WaitRetryTransfer, 7=Confirming, 8=Success, 9=Failed, 13=AuditPending, 14=PendingManualReview

### Transfer Status
0=Pending, 5=Success, 6=Failed, 14=DataAnomaly

### NotifyStatus
0=待處理, 1=成功, 2=重試達上限, 3=重試中, 4=不需要通知

## RabbitMQ Queues
- `withdraw.create_transfer`（20 workers）— 建立 Transfer
- `transfer.execute_transfer`（20 workers）— 執行鏈上轉帳
- 重試機制：商戶 `WithdrawRetryCount` 控制最大重試次數

## 四步診斷流程

### Step 1：查詢 cams-job 取得提現訂單與 transfer_id
```
cams-mcp.search_logs --index cams-job --query "order_id:WD{id}" --output json
```
從結果中提取 `transfer_id`（TR 前綴），關聯欄位為 `RelatedFromOrderID`。

### Step 2：根據 Order Status 判斷卡點
- `0 Pending`：查 withdraw.create_transfer queue 是否正常消費
- `1 CreateTransfer`：查 Transfer 建立 log，可能錢包選擇失敗
- `2 CreateTransferFail`：查失敗原因（常見：無可用 withdraw 錢包餘額不足）
- `3 TransferCreated`：查 transfer.execute_transfer queue
- `4 PreTransfer`：查 cryp 呼叫 log
- `5 ProcessTransfer`：鏈上執行中，查 cryp 端狀態
- `6 WaitRetryTransfer`：確認 RetryCount vs WithdrawRetryCount
- `7 Confirming`：正常等待鏈上確認
- `13 AuditPending`：通知審核人員處理
- `14 PendingManualReview`：查 Transfer 是否 StatusTRDataAnomaly(14)

### Step 3：用 transfer_id 查詢 cryp-* 鏈服務日誌
> **嚴格規則：絕對不要用 order_id 查詢 cryp-*，只能用 transfer_id**

根據 bankcode 映射選擇正確的 cryp index：
```
cams-mcp.search_logs --index cryp-{chain} --query "transfer_id:TR{id}" --output json
```

**找不到 transfer_id 的三種方法**：
1. **Lucene AND 組合查詢**：`order_id:WD{id} AND transfer_id:TR*`
2. **Log Context 展開**：找到訂單 log 後用 `cams-mcp.get_log_context --index cams-job --log_id {id} --before 5 --after 10 --output json`
3. **時間區間縮小**：用 `from_time`/`to_time` 縮小範圍避免 notify log 淹沒

### Step 4：判斷根因

#### cryp 錯誤訊息 → 根因對照
| 錯誤訊息關鍵字 | 根因 | 處理 |
|---------------|------|------|
| insufficient balance / not enough | Gas 不足或餘額不足 | 確認錢包主幣餘額 |
| nonce too low | Nonce 衝突 | cryp 團隊處理 |
| execution reverted | 合約執行失敗 | 查 TxHash 確認合約錯誤 |
| timeout / context deadline | 節點超時 | cryp 團隊確認節點狀態 |
| address not exist | 目標地址無效 | 確認 ToAddress 正確性 |
| connection refused | cryp 服務離線 | cryp 團隊重啟服務 |

## 提現錢包餘額不足
```
資金流向：用戶錢包(user) →[collection]→ 歸集錢包(collection) →[distribute]→ 提現錢包(withdraw) →[withdraw]→ 用戶指定地址
```
1. 查提現錢包(withdraw)餘額
2. 查下發排程 HandleDistributeFunds（每 2 分鐘），wallet.distribution queue（10 workers）
3. 查歸集錢包(collection)餘額
4. 查歸集排程 HandleCollectFunds（每 3 分鐘），wallet.collection queue
5. 整體資金不足 → 從外部補充

## 提現通知失敗
```
cams-mcp.search_logs --index cams-job --query "order_id:WD{id} AND notify" --output json
```
依 NotifyStatus 判斷。手動重試注意 2 分鐘 Redis 鎖。
通知欄位：memberid, orderid, withdraw_order, bankcode, amount, onchain_at, returncode, sign
