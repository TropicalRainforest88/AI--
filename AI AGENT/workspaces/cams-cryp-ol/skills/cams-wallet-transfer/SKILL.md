---
name: cams-wallet-transfer
description: 當使用者提到錢包轉帳、wallet transfer、內部轉帳、WT開頭訂單、審核超時、審核否決、轉帳限額時觸發
metadata:
  openclaw:
    emoji: "💸"
    requires:
      bins: ["mcporter"]
---

# CAMS 錢包轉帳問題診斷

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
| cams-api | 錢包轉帳發起、審核操作日誌 |
| cams-job | 審核超時排程、Transfer 執行日誌 |

## 核心原則：鏈上為真 (Chain is Truth)

> **「鏈上」= 區塊鏈本身的 RPC/Explorer 查詢結果，不是我們系統的 cryp-\* 日誌。**
> cryp-\* index 是我們 CRYP 服務寫入 ES 的內部 log，可能記錯。
> 只有透過區塊鏈公開 RPC 查到的數據才是「鏈上事實」。

當使用者提供鏈上資訊（金額、tx_hash 內容等），**不得僅靠系統日誌駁回使用者的鏈上觀察**。必須先用 tx_hash 透過區塊鏈 RPC 查詢實際交易，再與系統記錄比對。不一致本身就是需要報告的異常。

> 🚫 **禁止行為**：不得在未查鏈上數據的情況下，用後台日誌或 cryp-\* log 的結果告訴使用者「你看錯了」或「那是另一筆」。必須先拿 tx_hash 去驗證。

### 鏈上 RPC 查詢方法

以下是各鏈的公開 RPC 查詢指令，用於取得真正的鏈上數據：

**Solana（SOLUSDT）：**
```bash
curl -s https://api.mainnet-beta.solana.com -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getTransaction","params":["<tx_hash>",{"encoding":"jsonParsed","maxSupportedTransactionVersion":0}]}'
```
解析 `result.meta.preTokenBalances` 和 `postTokenBalances` 計算實際轉帳金額。
USDT mint: `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`

**TRON（TRCUSDT / TRC20）：**
```bash
curl -s https://api.trongrid.io/wallet/gettransactioninfobyid \
  -X POST -H "Content-Type: application/json" \
  -d '{"value":"<tx_hash>"}'
```

**EVM 鏈（ETH/BSC/Polygon/Arbitrum/Optimism/Base/Avalanche）：**
```bash
curl -s <rpc_url> -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["0x<tx_hash>"]}'
```
RPC URL 表：
| 鏈 | RPC URL |
|----|---------|
| ETH | `https://eth.llamarpc.com` |
| BSC | `https://bsc-dataseed.binance.org` |
| Polygon | `https://polygon-rpc.com` |
| Arbitrum | `https://arb1.arbitrum.io/rpc` |
| Optimism | `https://mainnet.optimism.io` |
| Base | `https://mainnet.base.org` |
| Avalanche | `https://api.avax.network/ext/bc/C/rpc` |

### 鏈上驗證步驟（當 cams-job 日誌中找到 tx_hash 時必須執行）

1. 從 cams-job 日誌中提取 `tx_hash` 和 `bankcode`（或鏈別資訊）
2. **用區塊鏈 RPC 查詢實際交易**（參考上方「鏈上 RPC 查詢方法」）
3. 同時查 cryp-\* index 取得系統記錄作為比對：
   ```
   cams-mcp.search_logs --index cryp-{chain} --query "tx_hash:{tx_hash}" --size 10 --output json
   ```
4. **比對三方數據**：鏈上 RPC（真相） vs cryp-\* log vs cams-job log
5. **若 RPC 查詢失敗**：必須在回覆中說明，不可假裝已驗證。同時仍需查 cryp index 作為輔助參考
6. **若系統記錄與鏈上 RPC 數據不一致**：這是異常，必須明確報告差異，不得自行解釋為「使用者看的是另一筆」

## 核心概念
- 由後台管理人員發起（非商戶 API）
- Transfer 類型：`internal`，透過 `RelatedFromOrderID` 關聯
- **審核流程**：發起 → AuditPending → AuditPass/AuditReject/AuditTimeout
- **審核超時**：2 小時（排程 `HandlerTimeoutWalletTransfer` 每 10 分鐘檢查）
- 否決或超時自動回滾錢包餘額
- 角色 `DailyTransferLimit` 限制每日轉帳額度，**admin 免除 USDT 限額**

## 狀態碼速查

### AuditStatus
| 值 | 名稱 | 說明 |
|----|------|------|
| 1 | AuditPending | 待審核 |
| 2 | AuditPass | 審核通過 |
| 3 | AuditReject | 審核否決（自動回滾餘額） |
| 4 | AuditTimeout | 審核超時（自動否決 + 回滾） |

### Order Status
| 值 | 名稱 |
|----|------|
| 0 | Pending |
| 1 | CreateTransfer |
| 8 | Success |
| 9 | Failed |
| 13 | AuditPending |

### Transfer Status
0=Pending, 5=Success, 6=Failed, 14=DataAnomaly

## 診斷流程

### 情境一：審核超時
```
cams-mcp.search_logs --index cams-job --query "order_id:WT{id} AND timeout" --output json
```

- **AuditStatus=4 (超時)**：超過 2 小時未處理，系統自動否決並回滾餘額。需重新發起轉帳申請。確認來源錢包餘額是否已正確回滾。
- **AuditStatus=1 (待審核)**：尚未超時，通知審核人員在 2 小時內處理。

### 情境二：審核否決
```
cams-mcp.search_logs --index cams-api --query "order_id:WT{id} AND audit" --output json
```

- **AuditStatus=3 (否決)**：查 AuditReason 確認否決原因
  - 餘額已回滾 → 根據否決原因調整後重新發起
  - 餘額未回滾 → 異常，查否決回滾 log 確認錯誤原因

### 情境三：角色轉帳限額不足
```
cams-mcp.search_logs --index cams-api --query "order_id:WT{id} AND limit" --output json
```

- **admin 角色**：免除 USDT 限額。若仍被拒，確認是否為其他幣種或其他錯誤
- **當日已用 + 本次 > DailyTransferLimit**：
  1. 等待次日額度重置
  2. 由 admin 代為執行
  3. 管理員調高角色 DailyTransferLimit（後台 > 系統管理 > 角色管理）
- **額度充足但被拒** → 查 ELK 錯誤 log 確認被拒原因

### 情境四：轉帳執行失敗（審核已通過）
```
cams-mcp.search_logs --index cams-job --query "order_id:WT{id}" --level error --output json
```

| 失敗原因 | 處理 |
|----------|------|
| Gas 不足 | 來源錢包主幣餘額不足，補充主幣 |
| 餘額不足 | TokenWallet.HoldingAmount 不足，注意發起時預扣 + 否決時回滾機制 |
| cryp 執行失敗 | **必須用 TransferID 繼續查 cryp 層**（見下方跨系統調查） |
| 鏈上交易失敗 | 用 TxHash 在區塊鏈瀏覽器確認原因 |

### 跨系統調查（CAMS → CRYP）

**重要**：當錢包轉帳涉及鏈上操作（如外轉至外部地址），CAMS 只負責建單和審核，實際鏈上執行由 CRYP 處理。**CAMS 查完後必須繼續查 CRYP 層**，不能只看 CAMS 日誌就下結論。

1. 從 CAMS 日誌取得 `transfer_id`（TR 開頭的單號）
2. 確認鏈別（SOL、ETH、TRON 等）
3. 用 `cryp-withdraw` skill 查 CRYP 層：
   ```
   cams-mcp.search_logs --index cryp-{chain} --query "transfer_id:{transfer_id}" --output json
   ```
4. 查看 withdraw 表的 status、has_chain、error message
5. 如有 tx_hash，查鏈上交易狀態

> **規則**：任何涉及「鏈上轉帳失敗」「手續費不足」「無法轉移」的問題，都必須查到 CRYP 層才能給出完整結論。

### 跨系統調查（CRYP → CAMS 通知回寫）

**重要**：當 TR 單卡在 processing 或 manual 狀態，除了查 CRYP 是否執行完成，**必須確認 CAMS 是否收到 CRYP 的通知回調**。

**必須依序執行，不可跳過：**

1. 在 cams-job 搜尋通知接收記錄（此步不可跳過！）：
   ```
   cams-mcp.search_logs --index cams-job --query "record transaction notify request" --from_time {建單時間-5min} --to_time {建單時間+2h} --size 50 --output json
   ```
   在結果中比對 `from_address` 或 `to_address` 是否與 TR 單吻合。

2. **若 CAMS 已收到通知**：
   - 問題在 CAMS 的通知處理/匹配邏輯，不是 CRYP
   - 取出 tx_hash，搜 `cams-job` 查後續處理是否建了 TX 單而非更新 TR 單
   - **結論歸屬 CAMS 端**

3. **若 CAMS 未收到通知**：
   - 用地址搜 `cryp-{chain}` 確認 CRYP 是否有發送
   - 若 CRYP 有發送記錄 → 查介面/網路問題
   - 若 CRYP 無記錄 → **結論歸屬 CRYP 端**

> **禁止**：不可僅憑 `cryp-{chain}` index 搜不到就歸咎 CRYP。搜不到可能是搜尋方式錯誤（參考 cryp-notify skill 的「搜尋 Fallback 策略」）。
