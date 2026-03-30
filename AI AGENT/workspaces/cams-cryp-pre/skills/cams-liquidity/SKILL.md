---
name: cams-liquidity
description: 當使用者提到流動池、liquidity pool、LP、添加流動性、移除流動性、LP開頭訂單、流動池滑點時觸發
metadata:
  openclaw:
    emoji: "🏊"
    requires:
      bins: ["mcporter"]
---

# CAMS 流動池問題診斷

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
| cams-job | 後台任務（liquidity_add/liquidity_remove Transfer 執行、通知） |

## 核心概念
- 操作類型：`add`（添加）和 `remove`（移除）
- Transfer 類型：add → `liquidity_add`（RelatedToOrderID），remove → `liquidity_remove`（RelatedFromOrderID）
- **涉及雙代幣**：FirstToken + SecondToken，兩者都需驗證
- **v2 vs v3 差異**：v2 會產生 LP Token（記錄在 ExtData），v3 不產生
- 滑點控制：商戶 `LiquidityPoolSlippage` 設定

## 狀態碼速查

### Order Status
| 值 | 名稱 |
|----|------|
| 0 | Pending |
| 1 | CreateTransfer |
| 2 | CreateTransferFail |
| 7 | Confirming |
| 8 | Success |
| 9 | Failed |

### Transfer Status
0=Pending, 5=Success, 6=Failed, 14=DataAnomaly

### NotifyStatus
0=待處理, 1=成功, 2=重試達上限, 3=重試中, 4=不需要通知

## 診斷流程

### Step 1：收集資訊
- OrderID（LP 前綴）
- Action 類型：add 或 remove
- Version：v2 或 v3
- 對應 Transfer 狀態

### Step 2：查詢訂單
```
cams-mcp.search_logs --index cams-job --query "order_id:LP{id}" --output json
```

### Step 3：前置檢查
- 確認商戶 `LiquidityPoolStatus` 是否啟用（未啟用 → 需先啟用）

### Step 4：依 Transfer 狀態判斷

**Transfer 建立失敗**：
```
cams-mcp.search_logs --index cams-job --query "order_id:LP{id}" --level error --output json
```
查錯誤 log，確認雙代幣驗證是否通過。

**Transfer 執行中**：
- 鏈上操作進行中，查 cryp 端交易狀態

**Transfer 失敗**：
- 滑點超限 → 見下方滑點診斷
- Gas 不足 → 錢包主幣餘額不足，補充主幣
- 合約執行錯誤 → 用 TxHash 查鏈上錯誤
- cryp 服務異常 → 提供 TransferID 轉交 cryp 團隊

**Transfer 成功但訂單未更新**：
- 狀態同步延遲，查訂單狀態更新 log

### v2 特有檢查
- 確認 ExtData 中的 LP Token 資訊是否正確記錄

## 滑點失敗診斷

計算兩個代幣各自的偏差百分比：
- FirstToken：|(ActualFirstAmount - FirstTokenAmount) / FirstTokenAmount| * 100%
- SecondToken：|(ActualSecondAmount - SecondTokenAmount) / SecondTokenAmount| * 100%

- **偏差 > LiquidityPoolSlippage** → 交易被正確拒絕，建議市場穩定時重試或調高滑點設定
- **偏差在範圍內但仍失敗** → 非滑點原因，查其他 ELK 錯誤 log

## 流動池通知失敗
```
cams-mcp.search_logs --index cams-job --query "order_id:LP{id} AND notify" --output json
```
依 NotifyStatus 判斷。URL 設定：`NotifyLiquidityPoolURL`。手動重試注意 2 分鐘 Redis 鎖。
