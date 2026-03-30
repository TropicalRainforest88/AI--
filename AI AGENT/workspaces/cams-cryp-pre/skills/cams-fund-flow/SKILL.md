---
name: cams-fund-flow
description: 當使用者提到歸集、collection、下發、distribution、手續費補充、supplement fee、資金流轉、資金不足時觸發
metadata:
  openclaw:
    emoji: "💸"
    requires:
      bins: ["mcporter"]
---

# CAMS 資金流轉診斷

## MCP 伺服器
- 名稱: cams-mcp
- 工具: search_logs, search_by_trace, get_log_context, get_error_summary, get_log_trend, list_indices, get_version
- **所有指令加 `--output json`**

## 背景知識

### 資金流向
```
用戶錢包 (user) →[歸集 collection]→ 歸集錢包 (collection) →[下發 distribute]→ 提現錢包 (withdraw)
```

### 排程與佇列
| 排程 | 週期 | Queue | Workers |
|------|------|-------|---------|
| HandleCollectFunds（歸集） | 每 3 分鐘 | wallet.collection | 20 |
| HandleDistributeFunds（下發） | 每 2 分鐘 | wallet.distribution | 10 |

### 歸集狀態碼 (CollectionStatus)
| 值 | 意義 | 處理方式 |
|----|------|---------|
| 1 | 待確認 | 等待排程處理 |
| 2 | 手續費補充中 | 等待 Gas 補充完成 |
| 3 | 手續費補充失敗 | 查手續費補充情境 |
| 4 | 歸集處理中 | 等待鏈上確認 |
| 5 | 歸集失敗 | 查失敗原因 |
| 6 | 不需要歸集 | 正常狀態 |

### 下發狀態碼 (DistributionStatus)
| 值 | 意義 |
|----|------|
| 1 | 待下發 |
| 2 | 下發處理中 |
| 3 | 下發失敗 |
| 4 | 下發成功 |
| 5 | 不需要下發 |

### ELK Index
- **cams-job**：歸集、下發、手續費補充等背景排程日誌（主要）

## 診斷情境

### 情境一：歸集未觸發

**收集資訊**：用戶錢包 ID、HoldingAmount、UserWalletLimit、CollectionStatus

**診斷步驟**：
1. 確認觸發條件：HoldingAmount > UserWalletLimit？
2. 若未超過 → 正常，不符合歸集條件
3. 若已超過 → 依 CollectionStatus 判斷卡點
4. 若排程異常 → 查 cams-job 與 wallet.collection queue

**查詢指令**：
```
cams-mcp.search_logs --index cams-job --query "HandleCollectFunds" --from_time "now-1h" --output json
cams-mcp.search_logs --index cams-job --query "wallet_id:{id} AND collection" --output json
cams-mcp.get_error_summary --index cams-job --field "message" --from_time "now-6h" --output json
```

### 情境二：歸集失敗（CollectionStatus=5）

**收集資訊**：CollectionStatus、Transfer 狀態與錯誤訊息

**診斷步驟**：
1. 查 collection Transfer 失敗原因
2. 手續費不足 → 進入情境三
3. 歸集錢包異常 → 確認錢包可用性
4. 鏈上失敗 → 用 TxHash 確認鏈上原因
5. cryp 服務異常 → 提供 TransferID 轉交 cryp 團隊

**查詢指令**：
```
cams-mcp.search_logs --index cams-job --query "collection AND failed" --level "error" --from_time "now-6h" --output json
cams-mcp.search_logs --index cams-job --query "transfer_id:{id}" --output json
```

### 情境三：手續費補充失敗

**收集資訊**：用戶錢包地址、主幣 HoldingAmount、Token.TransferFee、supplement_fee Transfer 狀態

**診斷步驟**：
1. 確認用戶錢包主幣（IsMain=true）< TransferFee → 需要補充
2. 查 supplement_fee Transfer 狀態（成功/失敗/未建立）
3. 補充來源不足 → 需手動向系統錢包轉入主幣
4. TRON 鏈：需確保主幣覆蓋 EnergyUsed + Fee + BandwidthFee

**查詢指令**：
```
cams-mcp.search_logs --index cams-job --query "supplement_fee" --from_time "now-6h" --output json
cams-mcp.search_logs --index cams-job --query "supplement_fee AND failed" --level "error" --output json
```

### 情境四：下發未觸發

**收集資訊**：提現錢包 HoldingAmount、歸集錢包 HoldingAmount

**診斷步驟**：
1. 提現錢包餘額充足 → 不需要下發，正常
2. 提現錢包不足但歸集錢包有餘額 → 查下發排程與 wallet.distribution queue
3. 歸集錢包也不足 → 確認歸集流程或從外部補充

**查詢指令**：
```
cams-mcp.search_logs --index cams-job --query "HandleDistributeFunds" --from_time "now-1h" --output json
cams-mcp.get_log_trend --index cams-job --interval "10m" --from_time "now-6h" --output json
```

### 情境五：下發失敗（DistributionStatus=3）

**收集資訊**：distribute Transfer 狀態與錯誤、DistributionStatus

**失敗原因**：
- 歸集錢包餘額不足 → 等待歸集或外部補充
- Gas 不足 → 手動補充主幣
- 單筆超過 CollectWalletTransferLimit → 分次下發或調高限額
- 鏈上交易失敗 → 用 TxHash 確認

**查詢指令**：
```
cams-mcp.search_logs --index cams-job --query "distribute AND failed" --level "error" --from_time "now-6h" --output json
cams-mcp.search_logs --index cams-job --query "distribution_status:3" --output json
```
