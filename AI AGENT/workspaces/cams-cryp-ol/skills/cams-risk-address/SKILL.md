---
name: cams-risk-address
description: 當使用者提到風險地址、risk address、黑名單地址、塵埃攻擊、dust attack、小額釣魚、風險充值退還時觸發
metadata:
  openclaw:
    emoji: "🚫"
    requires:
      bins: ["mcporter"]
---

# CAMS 風險地址事件診斷

## MCP 伺服器
- 名稱: cams-mcp
- 工具: search_logs, search_by_trace, get_log_context, get_error_summary, get_log_trend, list_indices, get_version
- **所有指令加 `--output json`**

## 背景知識

### 風險偵測機制
- 觸發時機：充值入帳時自動執行（來源地址檢查）
- 偵測來源：TronScan（TRON 鏈）、OKX（通用）
- 偵測函數：CheckTronScanRisk、CheckOKXRisk

### Transfer 風險狀態
| 狀態碼 | 常數 | 意義 |
|--------|------|------|
| 11 | StatusTRRiskAddress | 風險地址交易成功（資金已入帳但被標記） |
| 12 | StatusTRRiskAddressFailed | 風險地址交易失敗 |

### 塵埃攻擊
- Transfer 類型：`dust_attack`
- 特徵：極小金額充值，目的是誘導用戶誤轉到攻擊者地址

### 風險地址管理
- 後台路徑：區塊鏈管理 > 風險地址
- 權限：`block_chain > risk_address`（支援 read, create, update, delete）
- 可操作角色：Ops、admin

### ELK Index
- **cams-job**：風險偵測結果、風險地址充值處理、退還操作
- **cams-api**：風險地址管理（新增/刪除）API 請求
- 常用搜尋欄位：`from_address`、`risk_address`、`red_tag`、`transfer_id`

## 診斷情境

### 情境一：風險地址充值偵測

**收集資訊**：OrderID（DE 前綴）或 FromAddress、Transfer 狀態值、風險偵測來源與 RedTag

**診斷步驟**：
1. 確認 Transfer 狀態：11（標記成功）或 12（標記失敗）
2. 查 ELK 中 CheckTronScanRisk / CheckOKXRisk log
3. 取得偵測來源、RedTag（風險標籤）、IsRisk

**風險等級處理**：
- **高風險**（scam、money laundering、恐怖融資）→ 啟動退還流程 + 通報合規團隊 + 加入風險地址清單
- **中等風險**（一般風險標記）→ 標記觀察 + 風控團隊評估 + 記錄監控
- **誤判**→ 風控團隊確認後可從風險名單移除（後台 > 區塊鏈管理 > 風險地址 > 刪除）

**查詢指令**：
```
cams-mcp.search_logs --index cams-job --query "CheckTronScanRisk OR CheckOKXRisk" --from_time "now-6h" --output json
cams-mcp.search_logs --index cams-job --query "from_address:{address} AND risk" --output json
cams-mcp.search_logs --index cams-job --query "red_tag:* AND risk" --from_time "now-24h" --output json
```

### 情境二：風險地址充值退還

**收集資訊**：原始 Deposit OrderID、FromAddress（退還目標）、充值金額、用戶錢包主幣餘額

**診斷步驟**：
1. 確認退還目標地址（通常為原始 FromAddress）
2. 查 Token.TransferFee（鏈上手續費）
3. 確認用戶錢包主幣（IsMain=true）HoldingAmount >= TransferFee
4. 主幣不足 → 系統觸發 supplement_fee 補充 Gas；補充失敗 → 需手動轉入主幣
5. TRON 鏈：費用包含 Energy + Fee + BandwidthFee
6. 退還後追蹤：Transfer 狀態、TxHash 鏈上確認、地址加入風險清單

**查詢指令**：
```
cams-mcp.search_logs --index cams-job --query "order_id:{id} AND risk AND return" --output json
cams-mcp.search_logs --index cams-job --query "supplement_fee AND wallet_id:{id}" --output json
```

### 情境三：塵埃攻擊

**收集資訊**：受影響錢包地址、Transfer 類型是否為 `dust_attack`

**診斷步驟**：
1. Transfer 類型 = dust_attack → 系統已識別並標記，不影響正常業務
2. 類型非 dust_attack 但金額極小 → 評估是否為塵埃攻擊
3. 建議：將攻擊者地址加入風險地址清單，提醒用戶注意可疑小額交易

**查詢指令**：
```
cams-mcp.search_logs --index cams-job --query "dust_attack" --from_time "now-24h" --output json
cams-mcp.search_logs --index cams-job --query "wallet_address:{address} AND dust" --output json
cams-mcp.get_error_summary --index cams-job --field "message" --from_time "now-24h" --output json
```

### 情境四：手動管理風險地址

**操作路徑**：後台 > 區塊鏈管理 > 風險地址

**權限**：`block_chain > risk_address`（Ops、admin 角色）

**操作**：
- **新增**：加入後該地址後續充值自動標記為 StatusTRRiskAddress
- **查詢**：依地址、鏈、標籤條件搜尋
- **移除**：經風控團隊確認為誤判後刪除（移除後不再自動標記）

**查詢指令**：
```
cams-mcp.search_logs --index cams-api --query "risk_address AND create" --from_time "now-24h" --output json
cams-mcp.search_logs --index cams-api --query "risk_address AND delete" --from_time "now-24h" --output json
```
