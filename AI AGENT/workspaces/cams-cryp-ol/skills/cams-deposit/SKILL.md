---
name: cams-deposit
description: 當使用者提到充值、deposit、入金、沒到帳、未入帳、DE開頭訂單、風險地址充值時觸發
metadata:
  openclaw:
    emoji: "💰"
    requires:
      bins: ["mcporter"]
---

# CAMS 充值問題診斷

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
| cams-api | CAMS API 請求日誌（商戶請求、資產查詢） |
| cams-job | CAMS 後台任務（充值回調、通知、風險偵測） |

## 狀態碼速查

### Order Status
| 值 | 名稱 | 說明 |
|----|------|------|
| 0 | Pending | 待處理 |
| 1 | CreateTransfer | 建立轉帳單 |
| 2 | CreateTransferFail | 建立轉帳單失敗 |
| 7 | Confirming | 鏈上確認中 |
| 8 | Success | 成功 |
| 9 | Failed | 失敗 |
| 14 | PendingManualReview | 待人工處理 |

### Transfer Status
| 值 | 名稱 |
|----|------|
| 0 | StatusTRPending |
| 5 | StatusTRSuccess |
| 6 | StatusTRFailed |
| 11 | StatusTRRiskAddress（風險地址成功） |
| 12 | StatusTRRiskAddressFailed（風險地址失敗） |
| 14 | StatusTRDataAnomaly |

### NotifyStatus
| 值 | 說明 |
|----|------|
| 0 | 待處理 |
| 1 | 成功 |
| 2 | 重試達上限 |
| 3 | 重試中 |
| 4 | 不需要通知 |

## 核心原則：鏈上為真 (Chain is Truth)

> **「鏈上」= 區塊鏈本身的 RPC/Explorer 查詢結果，不是我們系統的 cryp-\* 日誌。**
> cryp-\* index 是我們 CRYP 服務寫入 ES 的內部 log，可能記錯。
> 只有透過區塊鏈公開 RPC 查到的數據才是「鏈上事實」。

當使用者提供鏈上資訊（金額、tx_hash 內容等），**不得僅靠系統日誌駁回使用者的鏈上觀察**。必須先用 tx_hash 透過區塊鏈 RPC 查詢實際交易，再與系統記錄比對。不一致本身就是需要報告的異常。

> 🚫 **禁止行為**：不得在未查鏈上數據的情況下，用後台日誌或 cryp-\* log 的結果告訴使用者「你看錯了」或「那是另一筆」。必須先拿 tx_hash 去驗證。

**鏈上 RPC 查詢方法**：參考 `cams-cryp-query` skill 的「鏈上 RPC 查詢方法」段落，內含各鏈（Solana/TRON/EVM）的 curl 查詢指令。

## 診斷流程

### Step 1：收集資訊
優先取得任一：OrderID（DE 前綴）、TxHash、ToAddress + 鏈/代幣/時間

**若使用者同時提供了鏈上查詢結果（如金額為 0、交易不存在等），記錄下來，在 Step 3 比對時使用。**

### Step 2：搜尋訂單
```
# 用 OrderID 搜尋
cams-mcp.search_logs --index cams-job --query "order_id:DE{id}" --output json

# 用 TxHash 搜尋
cams-mcp.search_logs --index cams-job --query "tx_hash:{hash}" --output json

# 用 ToAddress 搜尋
cams-mcp.search_logs --index cams-job --query "to_address:{addr}" --from_time {ISO} --to_time {ISO} --output json
```

### Step 3：決策判斷

**3a. 鏈上 RPC 驗證（若使用者提供了鏈上資訊）：**

若 Step 1 記錄了使用者提供的鏈上數據，先用 tx_hash 透過區塊鏈 RPC 查詢實際交易（參考 `cams-cryp-query` skill 的 RPC 查詢方法），再與 cryp-\* log 及 cams-job 記錄比對。不一致時必須在回覆中明確標示三方數據差異，不得自行解釋為「使用者看的是另一筆」。

**3b. 系統日誌判斷：**

**無回調記錄** → cryp 端未回調，需 cryp 團隊排查
**有回調無訂單** → 查 ReceiveTransactionNotify 後的錯誤 log（DB 寫入或資料驗證失敗）
- ⚠️ 若錯誤為 `deposit transfer already exist`：**檢查該筆交易是否為轉帳單（TR 前綴）而非充值單（DE 前綴）**。這表示 CRYP 通知的 tx_type=1（充值）與實際訂單類型不符，CAMS 誤以充值邏輯處理。根因在 CRYP 端的 tx_type 判定錯誤（應為 tx_type=2），需 CRYP RD 修復交易方向判定邏輯。
**有訂單** → 依 Order Status 判斷：
- `0 Pending`：超過 5 分鐘查 ELK 異常 log
- `1 CreateTransfer`：查 Transfer 建立 log
- `2 CreateTransferFail`：查錯誤 log（常見：資料驗證失敗）
- `7 Confirming`：正常，等待鏈上確認
- `8 Success`：已成功，確認商戶查看正確代幣
- `9 Failed`：查 ELK 失敗原因
- `14 PendingManualReview`：查 Transfer 是否為 StatusTRDataAnomaly(14)

### Step 4：額外檢查
1. MinDepositAmount — 金額低於最小值系統正常忽略
2. DepositStatus — 商戶充值功能是否啟用
3. 代幣是否在商戶設定中啟用

## 風險地址充值
```
cams-mcp.search_logs --index cams-job --query "order_id:DE{id} AND risk" --output json
```
- Transfer StatusTRRiskAddress(11)：資金已入帳但被標記
- Transfer StatusTRRiskAddressFailed(12)：風險地址交易失敗
- 確認偵測來源（TronScan/OKX）與 RedTag 內容
- 高風險 → 風險地址充值退還流程 + 通報合規
- 一般風險 → 標記觀察，風控評估

## 充值通知失敗
```
cams-mcp.search_logs --index cams-job --query "order_id:DE{id} AND notify" --output json
```
依 NotifyStatus 判斷（見上方表格）。手動重試注意 2 分鐘 Redis 鎖。
通知欄位：memberid, merchant_order, bankcode, from_address, address, amount, onchain_at, userid, returncode, sign
