---
name: cams-notify-alert
description: 當使用者提到通知失敗、webhook、回調失敗、商戶未收到通知、告警、alert、monitor、監控異常、鏈高度、大額轉帳、錢包閾值、淨資產差異時觸發
metadata:
  openclaw:
    emoji: "🔔"
    requires:
      bins: ["mcporter"]
---

# CAMS 通知與告警診斷

## MCP 伺服器
- 名稱: cams-mcp
- 工具: search_logs, search_by_trace, get_log_context, get_error_summary, get_log_trend, list_indices, get_version
- **所有指令加 `--output json`**

## 背景知識

### 通知機制
- 所有訂單類型共用同一套通知機制
- 流程：簽名驗證（SecretKey）→ 發送 → 重試 → Redis 鎖（2 分鐘）
- 訂單前綴：DE（充值）、WD（提現）、SW（兌換）、LP（流動池）

### NotifyStatus
| 值 | 意義 |
|----|------|
| 0 | 待處理 |
| 1 | 成功（HTTP 200） |
| 2 | 重試達上限 |
| 3 | 重試中 |
| 4 | 不需要通知（未設定 URL） |

### 通知 URL 對應
| 訂單類型 | URL 欄位 |
|---------|----------|
| 充值 | Merchant.NotifyDepositURL |
| 提現 | Merchant.NotifyWithdrawURL |
| 兌換 | Merchant.NotifySwapURL |
| 流動池 | Merchant.NotifyLiquidityPoolURL |

### 7 種告警類型
1. 鏈高度異常
2. 大額轉帳
3. 風險地址充值
4. 錢包餘額閾值
5. 提現時長異常
6. 淨資產差異
7. 錢包異常

### ELK Index
- **cams-job**：通知發送、重試、告警觸發等背景任務日誌
- **cams-api**：告警配置變更等 API 請求日誌

## 診斷情境

### 一、商戶通知問題

**收集資訊**：OrderID（DE/WD/SW/LP 前綴）、訂單類型、NotifyStatus、NotifyCount

**依 NotifyStatus 診斷**：

- **0（待處理）**：通知尚未發送，確認 cams-job 是否正常運作
- **1（成功）**：CAMS 端已送達，問題在商戶端（接收處理、簽名驗證 SecretKey）
- **2（重試達上限）**：確認商戶 Notify URL 是否可達、回應是否 200、SecretKey 是否一致
- **3（重試中）**：自動重試進行中，等待即可
- **4（不需要通知）**：商戶未設定對應 URL

**手動重試注意**：每筆訂單有 2 分鐘 Redis 鎖，鎖期間無法重複發送

**查詢指令**：
```
cams-mcp.search_logs --index cams-job --query "order_id:{id} AND notify" --output json
cams-mcp.search_logs --index cams-job --query "notify_status:2" --from_time "now-6h" --output json
cams-mcp.get_error_summary --index cams-job --field "message" --from_time "now-6h" --output json
cams-mcp.search_logs --index cams-job --query "notify AND failed" --level "error" --from_time "now-6h" --output json
```

### 二、告警處理

#### 2.1 鏈高度異常
確認哪條鏈節點高度異常。單一節點落後 → 通知基礎設施檢查；全部落後 → 鏈本身擁堵或升級。

```
cams-mcp.search_logs --index cams-job --query "chain height AND alert" --from_time "now-1h" --output json
```

#### 2.2 大額轉帳
取得 TransferID，查轉帳詳情（類型、來源、目的、金額）。正常業務 → 可忽略；來源異常 → 啟動風控調查。

```
cams-mcp.search_logs --index cams-job --query "transfer_id:{id}" --output json
cams-mcp.search_logs --index cams-job --query "large transfer AND alert" --from_time "now-1h" --output json
```

#### 2.3 風險地址充值
偵測到風險地址充值，參考 cams-risk-address skill 處理。

#### 2.4 錢包餘額閾值
確認觸發錢包與方向（低於下限/超過上限）。提現錢包低 → 查下發排程；用戶錢包高 → 查歸集排程。參考 cams-fund-flow skill。

```
cams-mcp.search_logs --index cams-job --query "wallet threshold AND alert" --from_time "now-1h" --output json
```

#### 2.5 提現時長異常
提現處理超時，取得 OrderID 後查提現卡住原因。

```
cams-mcp.search_logs --index cams-job --query "withdraw duration AND alert" --from_time "now-1h" --output json
```

#### 2.6 淨資產差異
帳面與鏈上不一致。用後台「餘額刷新」比對。鏈上多 → 查遺漏回調；帳面多 → 查 Transfer 鏈上狀態。差異持續 → 確認 SnapWalletAsset（每日 00:30）是否正常，可用 manual_in/manual_out 調整。

```
cams-mcp.search_logs --index cams-job --query "net asset AND alert" --from_time "now-1h" --output json
cams-mcp.search_logs --index cams-job --query "SnapWalletAsset" --from_time "now-24h" --output json
```

#### 2.7 錢包異常
確認異常錢包與最近交易。有未授權交易 → 立即暫停並安全調查。

```
cams-mcp.search_logs --index cams-job --query "wallet anomaly AND alert" --from_time "now-1h" --output json
```
