---
name: cams-cryp-query
description: 透過 mcporter 查詢 CAMS/CRYP 系統的訂單狀態、錯誤追蹤和日誌分析。當收到訂單號、transfer_id、trace_id 或系統異常回報時使用此 skill。
metadata:
  openclaw:
    emoji: "🔍"
    requires:
      bins: ["mcporter"]
---

# cams-cryp-query

CAMS/CRYP 日誌查詢與問題診斷。

## MCP 伺服器

- 名稱: pre-cams-mcp
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
| list_indices | 列出 indices | (無) |

**重要**：search_logs 結果按時間**倒序**（最新在前），`from_time`/`to_time` 使用 ISO 8601 格式。

## Index 對照表

### 業務系統
| Index | 用途 |
|-------|------|
| cams-api | CAMS API 請求日誌（商戶請求、資產查詢） |
| cams-job | CAMS 後台任務（提幣處理、轉帳、商戶通知） |

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
| cryp-dot | Polkadot |
| cryp-sui | Sui |
| cryp-sonic | Sonic |
| cryp-kaspa | Kaspa |

### bankcode → index 映射
| bankcode 關鍵字 | 對應 index |
|----------------|-----------|
| POLYGONUSDT | cryp-polygon |
| BNBUSDT, BSCUSDT | cryp-bsc |
| ETHUSDT, ERC20 | cryp-eth |
| TRCUSDT, TRC20 | cryp-tron |
| SOLUSDT | cryp-sol-v2 |

## 核心原則：鏈上為真 (Chain is Truth)

> **「鏈上」= 區塊鏈本身的 RPC/Explorer 查詢結果，不是我們系統的 cryp-\* 日誌。**
> cryp-\* index 是我們 CRYP 服務寫入 ES 的內部 log，可能記錯。
> 只有透過區塊鏈公開 RPC 查到的數據才是「鏈上事實」。

**當使用者提供鏈上資訊（金額、狀態、tx_hash 內容等），Agent 必須：**

1. **先驗證鏈上數據** — 用 tx_hash 透過區塊鏈 RPC 查詢實際交易記錄，確認鏈上金額、狀態
2. **不得僅靠系統日誌駁回使用者的鏈上觀察** — 系統日誌可能與鏈上不一致，不能用日誌反駁使用者提供的鏈上事實
3. **不一致本身就是異常** — 若系統記錄的金額/狀態與鏈上實際數據不符，這是需要報告的問題，不是「使用者看錯了」

> 🚫 **禁止行為**：Agent 不得在未查鏈上數據的情況下，用後台日誌或 cryp-\* log 的結果告訴使用者「你看到的 0 是另一筆」。必須先拿使用者提供的 tx_hash 去驗證。

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

## 訂單診斷流程（必須嚴格按順序，不可跳步）

收到訂單號時，**依序完成以下 5 個步驟**：

> **訂單前綴對照**：WD=提幣、DE=充值、TR=轉帳、WT=錢包轉帳、TX=交易。不同前綴對應不同的預期 tx_type，步驟 2 會用到。

### 步驟 0：用區塊鏈 RPC 驗證使用者提供的鏈上資訊

**若使用者提供了 tx_hash 或鏈上查詢結果（金額、狀態等），必須先驗證：**

1. **用區塊鏈 RPC 查詢實際交易**（參考上方「鏈上 RPC 查詢方法」段落）
2. **比對三方數據**：鏈上 RPC（真相） vs cryp-\* log vs cams-job log
   ```bash
   # 同時查 cryp-* 系統記錄作為比對
   mcporter call pre-cams-mcp.search_logs index=<cryp-index> query="tx_hash:<tx_hash>" size=10 --output json
   ```
3. **回覆必須包含**：
   - 鏈上實際金額（從 RPC 結果解析）
   - 系統記錄金額（從 cryp-\* log 提取）
   - tx_hash 完整值
4. **RPC 查詢失敗時**：必須在回覆中說明查詢失敗原因，不可假裝已驗證

**比對結果處理：**
- **三方一致** → 記錄確認結果，繼續步驟 1
- **不一致** → 這是異常，必須在最終回覆中明確標示：
  - 鏈上 RPC 查到的實際數據
  - cryp-\* log 記錄的數據
  - cams-job 記錄的數據
  - 差異具體在哪裡（金額、狀態、代幣類型等）
  - **不得自行解釋為「使用者看的是另一筆」，除非能提供具體證據（不同的 tx_hash）證明確實是不同交易**

### 步驟 1：查 cams-job 取基本資訊與 transfer_id

```bash
mcporter call pre-cams-mcp.search_logs index=cams-job query=<order_id> size=20 --output json
```

從結果提取：
- **bankcode** — 在 notify.request JSON 中，用於判斷對應的鏈 index
- **returncode** — "00" 成功，"04" 失敗
- **trace_id** — 可用於追蹤完整請求鏈
- **txids** — 空陣列表示未上鏈

#### ⚠️ 關鍵：提取 transfer_id

transfer_id 在「建立轉帳」的日誌中，通常在 transfer_data.request JSON 內。

**如果 20 筆結果全是 notify 日誌（message 含 "notify merchant"），表示 transfer 建立記錄被擠出了。** 失敗訂單每 30 秒產生一條 notify，會把較早的 transfer 建立記錄淹沒。

**當找不到 transfer_id 時，必須依序嘗試以下方法（優先用方法 1）：**

**方法 1（優先） — Lucene 精確搜尋**：直接搜含 transfer_id 的日誌，不受 notify 淹沒影響：
```bash
mcporter call pre-cams-mcp.search_logs index=cams-job query="<order_id> AND transfer_id" size=10 --output json
```

**方法 2 — log context**：取步驟 1 結果中最早一筆的 _id，往前看 50 筆：
```bash
mcporter call pre-cams-mcp.get_log_context index=cams-job log_id=<earliest_log_id> before=50 --output json
```

**方法 3 — 大範圍時間回溯**：設 from_time 為訂單日期的 00:00:00（而非只退 30 分鐘）：
```bash
mcporter call pre-cams-mcp.search_logs index=cams-job query=<order_id> size=50 from_time=<訂單日期>T00:00:00Z to_time=<最早notify的時間戳> --output json
```
⚠️ 注意：失敗訂單的 notify 每 30 秒一條，可能有數百條，transfer 建立記錄可能在數小時之前。不要只往前退 30 分鐘，要直接回到訂單建立當天的起始時間。

**🚫 不找到 transfer_id 就不能進入步驟 2。必須在步驟 1 完成 transfer_id 提取。**

### 步驟 2：用 transfer_id 查 cryp-* index

根據步驟 1 的 bankcode 查上方映射表，確定 cryp index：

```bash
mcporter call pre-cams-mcp.search_logs index=<cryp-index> query=<transfer_id> size=20 --output json
```

**🚫 絕對不能用 order_id（WD...）查 cryp-*，只能用 transfer_id（UUID 格式）。**

在結果中尋找：
- message: "add new withdrawal request" — 提幣請求
- message: "response logger" — 回應記錄（確認 status 200）
- message: "run withdraw error" — 執行失敗（含 error.message）
- **error.message 欄位 — 這是真正的錯誤原因**

#### ⚠️ 關鍵：驗證 tx_type 是否與訂單類型一致

CRYP 通知回 CAMS 時帶有 `tx_type` 欄位（1=充值, 2=提幣/轉帳）。**必須比對此值與原始訂單類型是否一致**：

| 訂單前綴 | 預期 tx_type | 說明 |
|---------|-------------|------|
| DE | 1 | 充值 |
| WD / TR / WT | 2 | 提幣/轉帳 |

若 tx_type 不符（如 TR 轉帳單收到 tx_type=1），這是 **CRYP 端的 bug** — CRYP 判定交易方向錯誤，導致 CAMS 以錯誤的邏輯處理通知。

**診斷方式**：在 cams-job 中搜尋 ReceiveTransactionNotify 相關日誌，檢查 CRYP 回調的 payload 中 tx_type 值：
```bash
mcporter call pre-cams-mcp.search_logs index=cams-job query="<transfer_id> AND ReceiveTransactionNotify" size=10 --output json
```

### 步驟 3：判斷根因

**3a. 先檢查步驟 0 的鏈上 RPC 驗證結果：**

若步驟 0 發現鏈上 RPC 數據與系統記錄（cryp-\* log 或 cams-job）不一致，必須優先報告此異常，不得被後續日誌分析結果覆蓋。

**3b. 根據 cryp-\* 日誌的 error.message：**

| error.message | 根因 | 失敗環節 |
|--------------|------|---------|
| balance insufficient | 熱錢包餘額不足 | CRYP |
| gas fee insufficient | Gas 費不足 | CRYP |
| nonce too low | 交易 nonce 衝突 | CRYP |
| timeout | 鏈節點超時 | CRYP |
| invalid address | 地址格式錯誤 | CAMS（參數錯誤） |
| record not found | 資料缺失 | CAMS |
| deposit transfer already exist | CRYP 通知的 tx_type 與訂單類型不符（如轉帳單被當充值處理） | CRYP（tx_type 判定錯誤） |

### 步驟 4：若 cryp 無記錄

若 transfer_id 在 cryp-* 中查不到，問題在 CAMS 端：

```bash
mcporter call pre-cams-mcp.search_by_trace index=cams-job trace_id=<trace_id> --output json
mcporter call pre-cams-mcp.search_logs index=cams-job query=<order_id> level=ERROR size=10 --output json
```

## 其他查詢

### 錯誤摘要
```bash
mcporter call pre-cams-mcp.get_error_summary index=<index> --output json
mcporter call pre-cams-mcp.get_error_summary index=<index> field=error.message.keyword --output json
```

### 日誌趨勢
```bash
mcporter call pre-cams-mcp.get_log_trend index=<index> interval=5m from_time=<ISO8601> to_time=<ISO8601> --output json
```

## 回覆格式

診斷完成後，按以下格式回覆：

**訂單 <order_id> 診斷結果**
- 商戶: <merchant_code>
- 金額: <amount> <幣種>
- 網路: <chain>
- Transfer ID: <transfer_id>
- 失敗環節: CAMS / CRYP
- 錯誤原因: <error.message 原文>
- 發生時間: <timestamp>
- 建議處理: <根據錯誤類型建議>
