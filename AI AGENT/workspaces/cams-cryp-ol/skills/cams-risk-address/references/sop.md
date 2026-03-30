# 風險地址事件處理

> **相關 Spec 參考**
> - [00-overview.md](../specs/00-overview.md) - 風險管理模組總覽
> - [01-glossary.md](../specs/01-glossary.md) - Risk Address、Dust Attack 定義
> - [02-order-flow.md](../specs/02-order-flow.md) - Transfer 狀態 StatusTRRiskAddress / StatusTRRiskAddressFailed
> - [06-integrations.md](../specs/06-integrations.md) - TronScan、OKX 風險偵測 API
> - [05-users-permissions.md](../specs/05-users-permissions.md) - block_chain > risk_address 權限

> **ELK 查詢指引**
> - **cams-job**：風險偵測結果、風險地址充值處理、退還操作等背景任務日誌
> - **cams-api**：風險地址管理（新增/刪除）API 請求日誌
> - 常用搜尋欄位：`from_address`、`risk_address`、`red_tag`、`transfer_id`

## 適用情境

系統偵測到風險地址相關活動，包括：風險地址充值入帳、塵埃攻擊、風險地址充值退還處理。

## 關鍵概念

- 風險偵測在充值入帳時自動執行
- 偵測來源：TronScan（TRON 鏈）、OKX（通用）
- 風險地址的充值 Transfer 狀態為 `StatusTRRiskAddress (11)` 或 `StatusTRRiskAddressFailed (12)`
- 塵埃攻擊 Transfer 類型為 `dust_attack`

---

## 情境一：風險地址充值偵測

### 觸發條件

充值交易入帳時，系統自動檢查來源地址並標記為風險。

### 處理流程

1. **確認風險標記**
   - 查 Transfer 狀態：`StatusTRRiskAddress (11)`
   - 查 FromAddress（來源地址）

2. **查詢風險偵測詳情**
   - 在 ELK 搜尋風險檢查 log（`CheckTronScanRisk` 或 `CheckOKXRisk`）
   - 取得偵測結果：
     - `RedTag`：風險標籤（如詐騙、洗錢等）
     - `IsRisk`：是否為風險地址

3. **風險評估**

| 風險類型 | 嚴重程度 | 建議處理 |
|----------|----------|----------|
| 詐騙相關 | 高 | 立即啟動退還流程，記錄並通報 |
| 洗錢相關 | 高 | 凍結資金，聯繫合規團隊 |
| 一般風險 | 中 | 標記觀察，評估是否退還 |
| 低風險標記 | 低 | 記錄並持續監控 |

4. **決定處理方式**
   - 退還：啟動風險地址充值退還流程
   - 觀察：標記但暫不處理
   - 上報：轉交合規/風控團隊

---

## 情境二：風險地址充值退還

### 觸發條件

經評估決定將風險地址的充值資金原路退還。

### 處理流程

1. **確認退還條件**
   - 確認原始 Deposit 訂單和 Transfer 資訊
   - 確認退還目標地址（通常為原始 FromAddress）
   - 確認退還金額

2. **手續費考量**
   - 退還交易需要 Gas 費用
   - 若用戶錢包主幣不足 → 需先透過 `supplement_fee` 補充
   - 確認 Token 的 `TransferFee` 設定

3. **執行退還**
   - 系統建立退還 Transfer
   - 等待鏈上交易確認
   - 確認退還成功

4. **後續記錄**
   - 記錄風險地址到風險地址清單
   - 更新風險地址資料庫
   - 若需要可透過後台 `risk_address` 功能管理

---

## 情境三：塵埃攻擊 (Dust Attack)

### 觸發條件

偵測到極小額的可疑轉帳，疑似塵埃攻擊/小額釣魚。

### 診斷步驟

1. **識別塵埃攻擊特徵**
   - 極小額轉帳（遠低於正常交易金額）
   - 可能來自多個不同地址
   - Transfer 類型標記為 `dust_attack`

2. **確認影響範圍**
   - 查受影響的錢包地址
   - 確認是否有用戶誤轉到攻擊者地址

3. **處理方式**
   - 塵埃攻擊的 Transfer 已被系統標記，不影響正常業務
   - 提醒相關用戶注意交易歷史中的可疑地址
   - 將攻擊者地址加入風險地址清單

---

## 情境四：手動管理風險地址

### 操作場景

透過後台管理風險地址清單（新增、查詢、刪除）。

### 權限需求

- 需要 `block_chain > risk_address` 權限
- 支援操作：read, create, update, delete
- Ops 角色和 admin 角色可操作

### 操作方式

1. **新增風險地址**
   - 手動將已知風險地址加入系統
   - 後續該地址的充值將自動被標記

2. **查詢風險地址**
   - 可依地址、鏈、標籤等條件查詢

3. **移除風險地址**
   - 經評估確認為誤判後，可移除風險標記
