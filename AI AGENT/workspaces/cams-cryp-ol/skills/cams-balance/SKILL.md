---
name: cams-balance
description: 當使用者提到錢包餘額、wallet balance、帳面差異、對帳、限額設定、threshold、成本損益、holding cost、手動轉入轉出、manual_in、manual_out時觸發
metadata:
  openclaw:
    emoji: "💰"
    requires:
      bins: ["mcporter"]
---

# CAMS 錢包餘額與資金管理診斷

## MCP 伺服器
- 名稱: cams-mcp
- 工具: search_logs, search_by_trace, get_log_context, get_error_summary, get_log_trend, list_indices, get_version
- **所有指令加 `--output json`**

## 背景知識

### 五種錢包類型
| 類型 | 用途 |
|------|------|
| user | 接收充值 |
| merchant | 商戶管理用 |
| withdraw | 提現出款 |
| collection | 歸集中繼 |
| external | 外部轉帳 |

### 關鍵欄位
- **帳面餘額**：TokenWallet.HoldingAmount
- **每日快照**：SnapWalletAsset，每日 00:30（Asia/Taipei）建立
- **成本欄位**：HoldingCost、HoldingAvgCost、CurrentInAmount、CurrentOutAmount

### 限額欄位
| 欄位 | 用途 |
|------|------|
| UserWalletLimit | 歸集觸發門檻 |
| CollectWalletLimit | 歸集錢包限額 |
| WithdrawWalletLimit | 提現錢包限額 |
| *TransferLimit（各錢包類型） | 單筆轉帳上限 |
| MinDepositAmount | 最小充值金額 |

### 價格同步
- 排程：SyncPrice，每 10 分鐘
- 來源：Binance、MEXC、FameEx、Cams 內部定價
- 資料：TradingPair.price

### 手動操作
- manual_in（人工轉入）：僅調帳面，不執行鏈上交易
- manual_out（人工轉出）：僅調帳面，不執行鏈上交易

### ELK Index
- **cams-job**：餘額快照、餘額刷新、成本計算等排程日誌
- **cams-api**：手動轉入/轉出、錢包設定變更等 API 請求日誌

## 診斷情境

### 情境一：帳面餘額與鏈上不一致

**收集資訊**：錢包地址或 ID、HoldingAmount（帳面）、鏈上實際餘額（後台「餘額刷新」取得）

**差異 = 鏈上餘額 - 帳面餘額**：
- **差異 = 0**：帳面與鏈上一致，無異常
- **差異 > 0**（鏈上多）：可能有未入帳充值（cryp 未回調）或外部直接轉入
- **差異 < 0**（帳面多）：可能 Transfer 帳面成功但鏈上失敗，或轉帳尚未完成

**修正方式**：確認原因後用 manual_in / manual_out Transfer 調整帳面

**後續追蹤**：確認 SnapWalletAsset（每日 00:30）正常建立；差異頻繁時排查 cryp 回調穩定度

**查詢指令**：
```
cams-mcp.search_logs --index cams-job --query "SnapWalletAsset" --from_time "now-24h" --output json
cams-mcp.search_logs --index cams-job --query "wallet_id:{id} AND balance" --output json
cams-mcp.search_logs --index cams-api --query "manual_in OR manual_out" --from_time "now-24h" --output json
cams-mcp.search_logs --index cams-job --query "wallet_address:{address}" --from_time "now-6h" --output json
```

### 情境二：代幣限額設定問題

**收集資訊**：問題代幣名稱、當前限額設定值、異常行為描述

**依異常行為診斷**：
- **歸集太頻繁** → UserWalletLimit 太低，適當提高以減少 Gas 消耗
- **歸集不觸發** → UserWalletLimit 太高，用戶錢包未達觸發條件
- **下發金額不足** → WithdrawWalletTransferLimit 或 CollectWalletTransferLimit 太低
- **單筆轉帳被拒** → 對應錢包類型的 TransferLimit 不夠，需調高或分次執行
- **小額充值被忽略** → MinDepositAmount 設定，低於此金額系統正常忽略

**查詢指令**：
```
cams-mcp.search_logs --index cams-job --query "HandleCollectFunds" --from_time "now-1h" --output json
cams-mcp.get_log_trend --index cams-job --interval "30m" --from_time "now-24h" --output json
```

### 情境三：成本與損益異常

**收集資訊**：錢包 ID、HoldingCost、HoldingAvgCost、CurrentInAmount、CurrentOutAmount、TradingPair 價格

**診斷步驟**：
1. **HoldingAvgCost 不合理** → 查最近 Transfer 的 UnitPrice 是否正常（UnitPrice 取自 TradingPair.price）
2. **TradingPair 價格異常** → 確認 SyncPrice 排程（每 10 分鐘）是否正常，比對 Binance/MEXC/FameEx 實際價格
3. **CurrentInAmount/CurrentOutAmount 不符** → 查是否有遺漏或重複的 Transfer 記錄

**查詢指令**：
```
cams-mcp.search_logs --index cams-job --query "SyncPrice" --from_time "now-1h" --output json
cams-mcp.search_logs --index cams-job --query "SyncPrice AND error" --level "error" --from_time "now-6h" --output json
cams-mcp.search_logs --index cams-job --query "trading_pair AND price" --from_time "now-1h" --output json
```

### 情境四：手動錢包操作指引

**帳面調帳**：manual_in / manual_out Transfer，僅調帳面不執行鏈上交易

**錢包類型變更**：後台 > 錢包管理 > 錢包詳情 > 類型變更（權限：wallet > details > update）。注意：變更影響資金流轉邏輯

**批次餘額刷新**：後台 > 錢包管理 > 批次刷新，同步鏈上實際餘額到帳面

**私鑰匯出**：後台 > 錢包管理 > 私鑰匯出（權限：wallet > secret_key > read，有審計追蹤）

**查詢指令**：
```
cams-mcp.search_logs --index cams-api --query "manual_in OR manual_out" --from_time "now-24h" --output json
cams-mcp.search_logs --index cams-api --query "wallet AND update" --from_time "now-24h" --output json
```
