---
name: cams-merchant
description: 當使用者提到商戶設定、merchant config、功能啟停、開關充值提現、通知URL、webhook設定、代幣設定、BankCode、滑點設定、slippage、新商戶接入時觸發
metadata:
  openclaw:
    emoji: "🏪"
    requires:
      bins: ["mcporter"]
---

# CAMS 商戶設定與管理診斷

## MCP 伺服器
- 名稱: cams-mcp
- 工具: search_logs, search_by_trace, get_log_context, get_error_summary, get_log_trend, list_indices, get_version
- **所有指令加 `--output json`**

## 背景知識

### 功能開關
| 欄位 | 功能 |
|------|------|
| DepositStatus | 充值開關 |
| WithdrawStatus | 提現開關 |
| SwapStatus | 兌換開關 |
| LiquidityPoolStatus | 流動池開關 |

### 通知 URL 對應
| 欄位 | 觸發時機 |
|------|---------|
| NotifyDepositURL | Deposit 訂單到達最終狀態 |
| NotifyWithdrawURL | Withdraw 訂單到達最終狀態 |
| NotifySwapURL | Swap 訂單到達最終狀態 |
| NotifyLiquidityPoolURL | LiquidityPool 訂單到達最終狀態 |
| NotifyMapURL（非必填） | TX ID 建立時 |

### 代幣設定
- BankTokenMapping：商戶 BankCode → 內部 ChainID + TokenID
- 路徑：後台 > 區塊鏈管理 > 銀行代碼映射
- 權限：`block_chain > bank_code_mapping`

### 滑點設定
- SwapSlippage：兌換滑點（如 0.5 = 0.5%）
- LiquidityPoolSlippage：流動池滑點

### 提現重試
- WithdrawRetryCount：提現失敗自動重試次數
- 每次重試重新選擇提現錢包並執行鏈上轉帳

### 權限
- 商戶管理：`system > merchant`（create, read, update, delete）

### ELK Index
- **cams-api**：商戶設定變更、功能啟停、代幣配置等 API 請求日誌
- 常用搜尋欄位：`merchant_id`、`merchant_name`

## 診斷情境

### 情境一：商戶功能啟停

**收集資訊**：MerchantID、需啟用或關閉的功能

**各功能影響**：
- **充值關閉**：鏈上交易仍可到達用戶錢包，但不建立 Deposit 訂單。已處理中的不受影響
- **提現關閉**：拒絕提現 API 請求，已建立的訂單繼續處理至完成
- **兌換關閉**：拒絕兌換 API 請求
- **流動池關閉**：拒絕流動池 API 請求

**操作路徑**：後台 > 系統管理 > 商戶管理 > 編輯
**權限**：`system > merchant > update`，立即生效

**查詢指令**：
```
cams-mcp.search_logs --index cams-api --query "merchant_id:{id} AND update" --from_time "now-24h" --output json
cams-mcp.search_logs --index cams-api --query "merchant_id:{id} AND status" --output json
```

### 情境二：商戶通知 URL 設定

**收集資訊**：商戶 ID、要設定或修改的通知類型

**設定檢查清單**：
1. URL 是否為有效 HTTP/HTTPS 端點
2. 商戶端是否能回應 HTTP 200
3. 商戶端是否已實作簽名驗證（SecretKey 計算 sign 欄位）
4. SecretKey 是否已正確同步給商戶

**注意**：未設定 URL → NotifyStatus = 4（不需要通知），系統不發送

**查詢指令**：
```
cams-mcp.search_logs --index cams-api --query "merchant_id:{id} AND notify_url" --output json
cams-mcp.search_logs --index cams-job --query "merchant_id:{id} AND notify AND failed" --level "error" --from_time "now-24h" --output json
```

### 情境三：商戶代幣設定（BankTokenMapping）

**收集資訊**：商戶 ID、需支援的鏈 + 代幣組合、商戶使用的 BankCode

**設定流程**：
1. 確認 BankTokenMapping（BankCode → ChainID + TokenID）是否存在
2. 映射不存在 → 先建立（後台 > 區塊鏈管理 > 銀行代碼映射）
3. 在商戶管理中啟用代幣
4. 同步建立對應錢包（user, withdraw, collection 等）

**查詢指令**：
```
cams-mcp.search_logs --index cams-api --query "merchant_id:{id} AND bank_code" --output json
cams-mcp.search_logs --index cams-api --query "bank_token_mapping" --from_time "now-24h" --output json
```

### 情境四：滑點設定調整

**收集資訊**：商戶 ID、當前 SwapSlippage 或 LiquidityPoolSlippage、問題描述

**調整建議**：
- **頻繁滑點失敗** → 小幅調高（如 0.5% → 1.0%），設定過高會導致商戶承受價格偏差
- **擔心價格偏差** → 降低滑點百分比，設定過低會增加交易失敗率
- **市場波動期** → 臨時調高（如 2-3%），穩定後調回；同時確認 TradingPair 價格同步（每 10 分鐘）

**操作路徑**：後台 > 系統管理 > 商戶管理 > 編輯

**查詢指令**：
```
cams-mcp.search_logs --index cams-api --query "merchant_id:{id} AND slippage" --output json
cams-mcp.search_logs --index cams-job --query "swap AND slippage AND failed" --level "error" --from_time "now-6h" --output json
```

### 情境五：提現重試設定

**收集資訊**：商戶 ID、當前 WithdrawRetryCount、問題描述

**調整建議**：
- **頻繁失敗不重試** → WithdrawRetryCount 可能為 0，建議設定 2-3 次
- **重試太多浪費 Gas** → 降低次數，優先排查失敗根因（餘額不足？地址錯誤？）
- 每次重試消耗 Gas，需權衡成本

### 情境六：新商戶接入清單

1. 建立商戶（MerchantID、SecretKey）
2. 設定功能開關（DepositStatus / WithdrawStatus / SwapStatus / LiquidityPoolStatus）
3. 設定通知 URL（NotifyDepositURL、NotifyWithdrawURL 等）
4. 配置代幣（BankTokenMapping + 啟用 Chain + Token）
5. 同步錢包（建立各類型錢包）
6. 設定滑點與重試（SwapSlippage、LiquidityPoolSlippage、WithdrawRetryCount）
7. 測試驗證（充值、提現流程 + 通知回調 + 簽名驗證）

**查詢指令**：
```
cams-mcp.search_logs --index cams-api --query "merchant_id:{id}" --from_time "now-24h" --output json
```
