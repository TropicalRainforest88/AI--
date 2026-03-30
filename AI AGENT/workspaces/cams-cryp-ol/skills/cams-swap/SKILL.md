---
name: cams-swap
description: 當使用者提到兌換、swap、換幣、代幣兌換、SW開頭訂單、滑點失敗、slippage時觸發
metadata:
  openclaw:
    emoji: "🔄"
    requires:
      bins: ["mcporter"]
---

# CAMS 兌換問題診斷

## MCP 伺服器
- 名稱: cams-mcp
- 工具: search_logs, search_by_trace, get_log_context, get_error_summary, get_log_trend, list_indices, get_version
- **所有指令加 `--output json`**

## 工具參數速查
| 指令 | 用途 | 關鍵參數 |
|------|------|---------|
| search_logs | 搜尋日誌 | index, query, size, level, from_time, to_time |
| search_by_trace | 用 trace_id 追蹤 | index, trace_id |
| get_log_context | 取得日誌前後文 | index, log_id, before, after |
| get_error_summary | 錯誤統計 | index, field, from_time, to_time |
| get_log_trend | 日誌趨勢 | index, interval, from_time, to_time |

> `from_time`/`to_time` 使用 ISO 8601 格式，結果為逆序（最新在前）。
> 查詢前先確認 `created_at` 時間，起始時間往前 2-5 分鐘。

## 相關 Index
| Index | 用途 |
|-------|------|
| cams-api | CAMS API 請求日誌 |
| cams-job | 後台任務（swap_from/swap_to Transfer 執行、通知） |

## 核心概念
- **每筆 Swap 產生兩筆 Transfer**：
  - `swap_from`（換出）— RelatedFromOrderID
  - `swap_to`（換入）— RelatedToOrderID
  - **兩筆都完成才算訂單成功**
- RabbitMQ：`swap.create_transfer`（**僅 1 Worker** — 高並發瓶頸！）
- 滑點控制：商戶 `SwapSlippage` 設定

## 狀態碼速查

### Order Status
| 值 | 名稱 |
|----|------|
| 0 | Pending |
| 1 | CreateTransfer |
| 2 | CreateTransferFail |
| 3 | TransferCreated |
| 5 | ProcessTransfer |
| 7 | Confirming |
| 8 | Success |
| 9 | Failed |

### Transfer Status
0=Pending, 5=Success, 6=Failed, 14=DataAnomaly

### NotifyStatus
0=待處理, 1=成功, 2=重試達上限, 3=重試中, 4=不需要通知

## 診斷流程

### Step 1：查詢訂單
```
cams-mcp.search_logs --index cams-job --query "order_id:SW{id}" --output json
```

### Step 2：確認兩筆 Transfer 狀態

提取 swap_from 與 swap_to 的 transfer_id，分別確認狀態。

### Step 3：決策判斷

**兩筆都未建立**：
- 查 `swap.create_transfer` queue（僅 1 Worker，大量 Swap 同時提交易積壓）
- 確認 cams-job 是否正常

**swap_from 處理中，swap_to 未開始**：
- 正常，換入需等換出完成
- 查 cryp 端 swap_from 交易狀態

**swap_from 成功，swap_to 未完成**：
```
cams-mcp.search_logs --index cams-job --query "transfer_id:TR{swap_to_id}" --output json
```
- 無回調 → cryp 端問題，提供 TransferID 給 cryp 團隊
- 有回調但失敗 → 查錯誤 log

**swap_from 失敗**：
- 查 TxHash 確認鏈上原因（Gas 不足、合約錯誤）

**兩筆都成功但訂單未更新**：
- 狀態同步延遲，查訂單狀態更新 log

## 滑點失敗診斷
```
cams-mcp.search_logs --index cams-job --query "order_id:SW{id} AND slippage" --output json
```

計算偏差 = |(ActualRate - Rate) / Rate| * 100%

- **偏差 > SwapSlippage** → 交易被正確拒絕，建議：市場穩定時重試，或調高 SwapSlippage
- **偏差 <= SwapSlippage 但仍失敗** → 非滑點原因，查其他錯誤 log
- **頻繁滑點失敗** → 查 SyncPrice 排程（每 10 分鐘）是否正常，TradingPair 價格同步狀態

## 兌換通知失敗
```
cams-mcp.search_logs --index cams-job --query "order_id:SW{id} AND notify" --output json
```
依 NotifyStatus 判斷。手動重試注意 2 分鐘 Redis 鎖。
通知欄位：swap_order, from_crypto, actual_from_amount, to_crypto, actual_to_amount, transaction_time, returncode
