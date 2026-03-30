---
name: cams-specs
description: "Use when needing CAMS system specifications, status code definitions, order flow details, billing rules, user permissions, or integration details. Keywords: CAMS規格、狀態碼定義、訂單流程、計費規則、權限、外部串接"
metadata:
  openclaw:
    emoji: "📚"
    requires:
      bins: ["mcporter"]
---

# CAMS 系統規格參考

## 1. 系統總覽

CAMS (Crypto Asset Management System) 是加密貨幣資產管理系統，為商戶提供充值、提現、兌換、流動池管理等核心服務。

### 系統架構

| 應用 | 端口 | 用途 |
|------|------|------|
| **cams-api** | 8801 | REST API 服務，處理所有 HTTP 請求 |
| **cams-job** | 8802 | 背景任務處理器，執行排程與非同步任務 |

**技術棧**：Go + Gin + GORM + PostgreSQL + Redis + RabbitMQ

### 主要業務模組

1. **訂單管理 (Order)**：充值、提現、兌換、流動池四種訂單
2. **轉帳管理 (Transfer)**：鏈上資金轉移，23 種轉帳類型
3. **錢包管理 (Wallet)**：多鏈多幣種，五種錢包類型
4. **資金流轉 (Fund Flow)**：歸集與下發
5. **風險管理 (Risk)**：風險地址偵測（TronScan、OKX）
6. **監控告警 (Monitor & Alert)**：七種告警類型
7. **商戶管理 (Merchant)**：啟停控制、通知 URL、代幣設定
8. **使用者與權限 (User & Permission)**：RBAC、JWT、TOTP
9. **計費與報表 (Billing & Report)**：手續費、價格追蹤、資產快照
10. **外部通知 (Notification)**：Webhook 通知商戶

### 系統角色

| 角色 | 說明 | MFA |
|------|------|-----|
| **admin** | 系統管理員，擁有全部權限，不受權限檢查限制 | 必要 |
| **visitor** | 訪客，僅有唯讀權限 | 非必要 |
| **Finance** | 財務人員，可查詢錢包與交易對 | 必要 |
| **Ops** | 營運人員，可管理 DNS、用戶、角色、商戶、鏈、代幣、錢包等 | 必要 |
| **Merchant Manager** | 商戶管理員，可管理商戶、銀行代碼映射、代幣 | 必要 |
| **QA Tester** | 測試人員，跨模組的綜合測試存取權限 | 必要 |

### 模組間業務關聯

```
商戶 (Merchant)
  │
  ├── 建立訂單 ──→ 充值/提現/兌換/流動池 (Order)
  │                    │
  │                    └── 產生轉帳單 ──→ 轉帳 (Transfer)
  │                                        │
  │                                        ├── 操作錢包 ──→ 錢包 (Wallet)
  │                                        │                  │
  │                                        │                  ├── 歸集/下發 ──→ 資金流轉
  │                                        │                  └── 餘額監控 ──→ 告警
  │                                        │
  │                                        ├── 鏈上交易 ──→ 交易明細 (Transaction)
  │                                        │                  │
  │                                        │                  └── 風險偵測 ──→ 風控 (Risk)
  │                                        │
  │                                        └── 價格追蹤 ──→ 交易對 (TradingPair)
  │
  └── 接收通知 ←── Webhook 回調 ←── 訂單狀態變更
```

---

## 2. 術語表

### 訂單相關

| 術語 | 定義 |
|------|------|
| **Order (訂單)** | 所有業務請求的頂層記錄，包含充值、提現、兌換、流動池訂單。每筆有唯一 OrderID（帶前綴） |
| **Deposit (充值)** | 用戶將加密貨幣轉入 CAMS 管理的錢包地址。前綴 `DE` |
| **Withdraw (提現)** | 用戶請求將加密貨幣從 CAMS 轉出到指定地址。前綴 `WD` |
| **Swap (兌換)** | 同一條鏈上將一種加密貨幣兌換為另一種。包含 swap_from + swap_to。前綴 `SW` |
| **LiquidityPool (流動池)** | 向 DeFi 流動池添加或移除流動性。支援 v2/v3。前綴 `LP` |
| **MerchantOrderID** | 商戶系統中的訂單編號，用於商戶端對應 |

### 轉帳相關

| 術語 | 定義 |
|------|------|
| **Transfer (轉帳單)** | 實際執行鏈上資金轉移的記錄。前綴 `TR` |
| **Transaction (交易明細)** | 鏈上交易的詳細記錄，包含 TxHash、鏈上時間。前綴 `TX` |
| **TxHash** | 區塊鏈上的交易唯一識別碼 |
| **RelatedFromOrderID** | Transfer 與資金流出方訂單的關聯（如 Withdraw） |
| **RelatedToOrderID** | Transfer 與資金流入方訂單的關聯（如 Deposit） |

### 錢包相關

| 類型代碼 | 名稱 | 定義 |
|----------|------|------|
| `user` | 用戶錢包 | 分配給終端用戶的充值地址 |
| `merchant` | 商戶錢包 | 屬於商戶的錢包，商戶層級資金管理 |
| `withdraw` | 提現錢包 | 用於執行提現出款，需維持足夠餘額 |
| `collection` | 歸集錢包 | 資金歸集的中繼錢包 |
| `external` | 外轉錢包 | 外部轉帳使用 |

| 術語 | 定義 |
|------|------|
| **TokenWallet** | 錢包中特定代幣的持有記錄 |
| **HoldingAmount** | TokenWallet 的帳面持有數量 |
| **HoldingCost / HoldingAvgCost** | 代幣持有的總成本與平均成本 |

### 資金流轉

| 術語 | 定義 |
|------|------|
| **Collection (歸集)** | 將用戶錢包中的資金匯集到歸集錢包。餘額超過上限時觸發 |
| **Distribution (下發)** | 將歸集錢包資金分配到提現錢包，確保流動性 |
| **Supplement Fee** | 主幣不足時自動補充手續費的機制 |
| **WalletTransfer** | 後台人員發起的內部錢包間轉帳，需審核。前綴 `WT` |

### 鏈與代幣

| 術語 | 定義 |
|------|------|
| **Chain** | 區塊鏈網路（Ethereum、TRON、BSC 等） |
| **Token** | 區塊鏈上的加密貨幣（主幣或合約代幣） |
| **Main Token** | 鏈的原生代幣，用於支付 Gas。`IsMain = true` |
| **TradingPair** | 代幣市場價格追蹤設定（Binance、MEXC、FameEx、Cams） |
| **BankTokenMapping** | 商戶 BankCode 對應到 CAMS 的 Chain + Token 組合 |

### 風控相關

| 術語 | 定義 |
|------|------|
| **Risk Address** | 有風險的區塊鏈地址（詐騙、洗錢），透過 TronScan、OKX 偵測 |
| **Risk Address Deposit Return** | 風險地址充值時退還資金的流程 |
| **Dust Attack** | 攻擊者發送極小額交易誘導目標轉帳。Transfer 類型 `dust_attack` |

### 其他

| 術語 | 定義 |
|------|------|
| **Merchant** | 接入 CAMS 的業務方，有獨立 SecretKey、通知 URL、功能啟停控制 |
| **Notify** | 訂單狀態變更後透過 Webhook 通知商戶，含簽名驗證與重試 |
| **Slippage (滑點)** | 兌換/流動池操作允許的最大價格偏差百分比 |
| **Audit (審核)** | 特定操作需人工審核（待審核、通過、否決、超時） |
| **Manual Review** | 系統無法自動處理的異常，需人工介入 |
| **FinalizedAt** | 訂單或轉帳達到最終狀態的時間戳 |
| **Reconciliation** | 比對帳面記錄與鏈上數據的一致性驗證 |

---

## 3. 訂單主流程

### 訂單狀態 (Order Status)

> 定義於 `kit/common/stauts.go`

| 值 | 常數 | 中文 | 說明 |
|----|------|------|------|
| 0 | StatusOrderPending | 訂單待處理 | 初始狀態 |
| 1 | StatusOrderCreateTransfer | 建立轉帳單 | 正在建立 Transfer |
| 2 | StatusOrderCreateTransferFail | 建立轉帳單失敗 | 可重試 |
| 3 | StatusOrderTransferCreated | 轉帳單已建立 | Transfer 建立成功 |
| 4 | StatusOrderPreTransfer | 轉帳前準備 | 準備執行鏈上轉帳 |
| 5 | StatusOrderProcessTransfer | 轉帳處理中 | 鏈上執行中 |
| 6 | StatusOrderWaitRetryTransfer | 等待重試轉帳 | 轉帳失敗，等待重試 |
| 7 | StatusOrderConfirming | 訂單確認中 | 等待鏈上確認 |
| 8 | StatusOrderSuccess | 訂單成功 | **最終狀態** |
| 9 | StatusOrderFailed | 訂單失敗 | **最終狀態** |
| 10 | StatusOrderAuditReject | 審核否決 | **最終狀態** |
| 11 | StatusOrderAuditPass | 審核通過 | 繼續處理 |
| 12 | StatusOrderAuditTimeout | 審核超時 | **最終狀態** |
| 13 | StatusOrderAuditPending | 審核待處理 | 等待人工審核 |
| 14 | StatusOrderPendingManualReview | 待人工處理 | 需人工介入 |

### 訂單狀態流程

```
[建立] → Pending(0)
  ├─→ CreateTransfer(1) → TransferCreated(3) → PreTransfer(4) → ProcessTransfer(5)
  │     └─→ CreateTransferFail(2) → 重試 → CreateTransfer(1) / Failed(9)
  │
  ├─→ ProcessTransfer(5) → Confirming(7) → Success(8) / Failed(9)
  │     ├─→ WaitRetryTransfer(6) → PreTransfer(4) / Failed(9)
  │     └─→ PendingManualReview(14)
  │
  └─→ AuditPending(13) → AuditPass(11) → CreateTransfer(1)
        ├─→ AuditReject(10)
        └─→ AuditTimeout(12)
```

### 轉帳狀態 (Transfer Status)

| 值 | 常數 | 中文 | 說明 |
|----|------|------|------|
| 0 | StatusTRPending | 待處理 | 初始狀態 |
| 1 | StatusTRPreTransfer | 轉帳前準備 | 準備執行 |
| 2 | StatusTRProcessTransfer | 轉帳處理中 | 執行中 |
| 3 | StatusTRWaitRetryTransfer | 等待重試轉帳 | 失敗後等待重試 |
| 4 | StatusTRConfirming | 轉帳確認中 | 等待鏈上確認 |
| 5 | StatusTRSuccess | 成功 | **最終狀態** |
| 6 | StatusTRFailed | 失敗 | **最終狀態** |
| 7 | StatusTRWaitRetry | 等待重試 | 已棄用 |
| 8 | StatusTRAuditPending | 審核中 | 等待審核 |
| 9 | StatusTRAuditPass | 審核通過 | |
| 10 | StatusTRAuditReject | 審核否決 | **最終狀態** |
| 11 | StatusTRRiskAddress | 風險地址交易成功 | 來自風險地址 |
| 12 | StatusTRRiskAddressFailed | 風險地址交易失敗 | |
| 13 | StatusTRPendingManualReview | 待人工處理 | 需人工介入 |
| 14 | StatusTRDataAnomaly | 交易資料異常 | Gas 費不入帳，修正後再處理 |

### 交易明細狀態 (Transaction Status)

| 值 | 常數 | 中文 |
|----|------|------|
| 0 | StatusTXPending | 待處理 |
| 1 | StatusTXSuccess | 成功 |
| 2 | StatusTXProcessing | 處理中 |
| 3 | StatusTXWaitRetry | 等待重試 |
| 4 | StatusTXFailed | 失敗 |
| 5 | StatusTXAddressNotExist | 地址不存在 |
| 6 | StatusTXDataAnomaly | 交易資料異常 |

### 通知狀態 (Notify Status)

| 值 | 常數 | 中文 |
|----|------|------|
| 0 | StatusNotifyPending | 待處理 |
| 1 | StatusNotifySuccess | 通知成功 |
| 2 | StatusNotifyRetryLimitReached | 重試次數達上限 |
| 3 | StatusNotifyRetrying | 重試中 |
| 4 | StatusNotifyUnrequired | 不需要通知 |

### 審核狀態 (WalletTransfer Audit Status)

| 值 | 常數 | 說明 |
|----|------|------|
| 1 | StatusWalletTransferAuditPending | 待審核 |
| 2 | StatusWalletTransferAuditPass | 審核通過 |
| 3 | StatusWalletTransferAuditReject | 審核否決 |
| 4 | StatusWalletTransferAuditTimeout | 審核超時（2 小時） |
| 5 | StatusWalletTransferAuditNotRequired | 不需要審核 |

### 對帳狀態 (Reconciliation Status)

| 值 | 說明 |
|----|------|
| 0 | StatusReconcileNotDefined - 未定義 |
| 1 | StatusReconcileSuccess - 對帳成功 |
| 2 | StatusReconcileFailed - 對帳失敗 |
| 3 | StatusReconcileNoPreviousData - 無前一天資料 |

---

## 4. 訂單完整生命週期

### 充值 (Deposit) 流程

1. 鏈上偵測到用戶轉入交易 → cams-job 收到 cryp 回調
2. 建立 Transaction 記錄
3. 建立 Deposit 訂單 + Transfer（類型 `deposit`）
4. 風險地址檢查：若為風險地址 → Transfer 標記為 `StatusTRRiskAddress`
5. 訂單狀態更新為 Success
6. 觸發 Dashboard 聚合更新
7. 非同步通知商戶 (NotifyDepositURL)
8. 觸發歸集評估

**通知內容**：`memberid`, `merchant_order`, `bankcode`, `from_address`, `address`, `amount`, `onchain_at`, `userid`, `returncode`, `sign`

### 提現 (Withdraw) 流程

1. 商戶透過 API 提交提現請求 → 建立 Withdraw 訂單
2. 發送 RabbitMQ 訊息 (`withdraw.create_transfer`)
3. 建立 Transfer（類型 `withdraw`）
4. 發送 RabbitMQ 訊息 (`transfer.execute_transfer`)
5. 呼叫 cryp 服務執行鏈上轉帳
6. 等待 cryp 回調確認結果
7. 更新 Transfer + Withdraw 狀態
8. 觸發 Dashboard 聚合更新
9. 非同步通知商戶 (NotifyWithdrawURL)
10. 若失敗且未達重試上限 → 回到步驟 4 重試

**通知內容**：`memberid`, `orderid`, `withdraw_order`, `bankcode`, `amount`, `onchain_at`, `returncode`, `sign`

### 兌換 (Swap) 流程

1. 商戶透過 API 提交兌換請求 → 建立 Swap 訂單
2. 發送 RabbitMQ 訊息 (`swap.create_transfer`)
3. 建立兩筆 Transfer：swap_from（換出）+ swap_to（換入）
4. 執行鏈上兌換交易
5. cryp 回調分別處理 swap_from 和 swap_to
6. 兩筆都完成 → Swap 訂單狀態更新
7. 非同步通知商戶 (NotifySwapURL)

**通知內容**：`swap_order`, `from_crypto`, `actual_from_amount`, `to_crypto`, `actual_to_amount`, `transaction_time`, `returncode`

### 流動池 (LiquidityPool) 流程

1. 商戶透過 API 提交流動池操作 → 建立 LiquidityPool 訂單
2. 根據 Action（add/remove）建立對應 Transfer
3. 執行鏈上操作
4. cryp 回調處理結果
5. 非同步通知商戶 (NotifyLiquidityPoolURL)

---

## 5. 訂單類型

### 訂單類型總覽

| 類型 | 前綴 | 模型 | 來源 |
|------|------|------|------|
| Deposit | DE | `model.Deposit` | 鏈上偵測 |
| Withdraw | WD | `model.Withdraw` | 商戶 API |
| Swap | SW | `model.Swap` | 商戶 API |
| LiquidityPool | LP | `model.LiquidityPool` | 商戶 API |
| WalletTransfer | WT | `model.WalletTransfer` | 後台操作 |

### Deposit 核心欄位

| 欄位 | 說明 |
|------|------|
| OrderID | 訂單編號（DE 前綴） |
| MerchantID | 所屬商戶 |
| TokenID / ChainID | 代幣與鏈 |
| Amount | 充值金額 |
| ToAddress | 接收地址 |
| Status | 訂單狀態 |
| NotifyStatus | 商戶通知狀態 |
| FinalizedAt | 完結時間 |

**業務規則**：被動觸發（鏈上偵測）、最小金額 `MinDepositAmount`、風險檢查、歸集觸發、一筆 Deposit 對應一筆 Transfer（`deposit`）

### Withdraw 核心欄位

| 欄位 | 說明 |
|------|------|
| OrderID | 訂單編號（WD 前綴） |
| MerchantOrderID | 商戶訂單號 |
| MerchantID | 所屬商戶 |
| TokenID / ChainID | 代幣與鏈 |
| Amount | 提現金額 |
| ToAddress | 目標地址 |
| RetryCount | 重試次數 |
| Status / NotifyStatus / FinalizedAt | 狀態追蹤 |

**業務規則**：商戶 `WithdrawStatus` 必須啟用、重試上限 `WithdrawRetryCount`、從 withdraw 類型錢包選擇餘額足夠的、一筆對應一筆 Transfer（`withdraw`）

### Swap 核心欄位

| 欄位 | 說明 |
|------|------|
| OrderID | 訂單編號（SW 前綴） |
| FromTokenID / FromAmount | 換出代幣與金額 |
| ActualFromAmount | 實際換出金額 |
| ToTokenID / ToAmount | 換入代幣與金額 |
| ActualToAmount | 實際換入金額 |
| Rate / ActualRate | 預期/實際匯率 |

**業務規則**：商戶 `SwapStatus` 必須啟用、滑點控制 `SwapSlippage`、雙向 Transfer（swap_from + swap_to）、兩筆都完成才算成功

### LiquidityPool 核心欄位

| 欄位 | 說明 |
|------|------|
| OrderID | 訂單編號（LP 前綴） |
| Version | 版本（v2/v3） |
| Action | 操作類型（add/remove） |
| FirstTokenID / FirstTokenAmount | 第一代幣與金額 |
| SecondTokenID / SecondTokenAmount | 第二代幣與金額 |
| ExtData | 擴展資料（v2 含 LP Token） |

**業務規則**：商戶 `LiquidityPoolStatus` 必須啟用、滑點 `LiquidityPoolSlippage`、Add 類型 `liquidity_add`、Remove 類型 `liquidity_remove`

### WalletTransfer

**業務規則**：後台發起、需審核（超時 2 小時自動否決）、每角色有 `DailyTransferLimit`（admin 免除 USDT 限額）、否決回滾餘額、Transfer 類型 `internal`

---

## 6. Transfer 類型完整列表（23 種）

| 類型 | 常數 | 說明 | 關聯訂單 |
|------|------|------|----------|
| deposit | TypeTRDeposit | 充值入帳 | Deposit |
| withdraw | TypeTRWithdraw | 提現出款 | Withdraw |
| swap_from | TypeTRSwapFrom | 兌換換出 | Swap |
| swap_to | TypeTRSwapTo | 兌換換入 | Swap |
| liquidity_add | TypeTRLiquidityAdd | 流動性增加 | LiquidityPool |
| liquidity_remove | TypeTRLiquidityRemove | 流動性移除 | LiquidityPool |
| internal | TypeTRInternal | 內部轉帳 | WalletTransfer |
| collection | TypeTRCollection | 歸集 | - |
| distribute | TypeTRDistribute | 下發 | - |
| fee | TypeTRFee | 手續費 | - |
| supplement_fee | TypeTRSupplementFee | 手續費補充 | - |
| manual_in | TypeTRManualIn | 人工轉入 | - |
| manual_out | TypeTRManualOut | 人工轉出 | - |
| contract | TypeTRContract | 合約代幣扣款 | - |
| dust_attack | TypeTRDustAttack | 塵埃攻擊 | - |
| system_error | TypeTRSystemError | 系統錯誤 | - |
| undefined | TypeTRUndefined | 未定義 | - |
| undefined_deposit | TypeTRUndefinedDeposit | 未定義(充值) | - |
| undefined_withdraw | TypeTRUndefinedWithdraw | 未定義(提現) | - |
| undefined_swap_from | TypeTRUndefinedSwapFrom | 未定義(兌換換出) | - |
| undefined_swap_to | TypeTRUndefinedSwapTo | 未定義(兌換換入) | - |
| undefined_liquidity_add | TypeTRUndefinedLiquidityAdd | 未定義(流動性增加) | - |
| undefined_liquidity_remove | TypeTRUndefinedLiquidityRemove | 未定義(流動性移除) | - |

---

## 7. 計費與資金管理

### 手續費 (Transfer Fee)

- 每個 Token 設定 `TransferFee`，以該鏈主幣計價
- 鏈上交易時自動建立 `fee` 類型 Transfer
- 主幣餘額不足時（`HoldingAmount < TransferFee`），自動建立 `supplement_fee` Transfer 補充 Gas

### 代幣限額設定

| 欄位 | 說明 |
|------|------|
| UserWalletLimit | 用戶錢包儲存上限 |
| CollectWalletLimit | 歸集錢包儲存上限 |
| WithdrawWalletLimit | 出款錢包儲存上限 |
| UserWalletTransferLimit | 用戶錢包單筆轉帳上限 |
| CollectWalletTransferLimit | 歸集錢包單筆轉帳上限 |
| WithdrawWalletTransferLimit | 出款錢包單筆轉帳上限 |
| MinDepositAmount | 最小充值金額 |

### 價格追蹤

| 來源 | API |
|------|-----|
| Binance | `https://api.binance.com/api/v3/ticker/price` |
| MEXC | `https://api.mexc.com/api/v3/ticker/price` |
| FameEx | `https://openapi.fameex.com/v2/public/ticker` |
| Cams (內部) | 內部設定價格 |

每 10 分鐘自動同步。每筆 Transfer 記錄 `UnitPrice` 用於 USD 等值計算、Dashboard 聚合、損益報表。

### 商戶滑點設定

| 設定 | 說明 |
|------|------|
| SwapSlippage | 兌換滑點（百分比，如 0.5 = 0.5%） |
| LiquidityPoolSlippage | 流動池滑點（百分比） |

### 成本追蹤 (TokenWallet)

| 欄位 | 說明 |
|------|------|
| HoldingCost | 持有成本（歷史累計） |
| HoldingAvgCost | 持有平均成本 |
| CurrentInAmount | 當前轉入量 |
| CurrentOutAmount | 當前轉出量 |

### 資產快照與報表

- **每日快照**：每日 00:30（Asia/Taipei）建立 `SnapWalletAsset`
- **Dashboard 聚合**：Transfer 完成時自動更新 `MonitorDashboard`（按商戶/鏈/代幣/小時分組）

### 資金流轉

#### 歸集 (Collection)

```
用戶錢包 (user) ──[collection]──→ 歸集錢包 (collection)
```

觸發條件：用戶錢包餘額超過 `UserWalletLimit`

| 值 | 說明 |
|----|------|
| 1 | 待確認 |
| 2 | 手續費補充中 |
| 3 | 手續費補充失敗 |
| 4 | 歸集處理中 |
| 5 | 歸集失敗 |
| 6 | 不需要歸集（預設值） |

#### 下發 (Distribution)

```
歸集錢包 (collection) ──[distribute]──→ 提現錢包 (withdraw)
```

觸發條件：提現錢包餘額低於所需水位

| 值 | 說明 |
|----|------|
| 1 | 待下發 |
| 2 | 下發處理中 |
| 3 | 下發失敗 |
| 4 | 下發成功 |
| 5 | 不需要下發（預設值） |

---

## 8. 角色與權限

### 認證機制

**JWT Token**：登入後取得 Access Token → `Authorization: Bearer <token>` → Token 含 `org`（組織/DNS 域名），用組織專屬密鑰加解密 → 過期透過 `/auth/refresh` 換發

**登入會話**：存於 Redis（`LoginHistory` key），含 `access_token` 和 `last_action`，每次驗證確認一致

**MFA**：以角色為單位設定，TOTP 密鑰存於 `User.TotpSecret`

**Google OAuth**：`GET /auth/google`（取得 URL）、`GET /auth/google/validation`（驗證回調）

### 角色規則

- 一人一角色（`user_role` 表 UNIQUE 約束）
- admin 不可刪除，admin 用戶不可變更角色
- 正式環境可自訂角色並分配權限

### 權限結構

| 欄位 | 說明 | 範例 |
|------|------|------|
| Method | HTTP 方法 | GET, POST, PUT, DELETE |
| Path | API 路徑（不含 /api/v1） | /wallet, /user/:user_id |
| Module | 業務模組 | monitor, block_chain, wallet, order, finance, system |
| Feature | 功能分類 | data_monitor, chain, role, user, merchant |
| Action | 操作類型 | read, create, update, delete |
| Status | 權限狀態 | 1=啟用, 2=停用 |

### 權限檢查流程

```
HTTP 請求 → Auth Middleware（JWT 驗證）
  → 驗證 Token 簽名與有效期
  → 確認用戶存在且啟用 (status=1)
  → 確認 Redis 登入會話有效

→ Permission Middleware（權限檢查）
  → 用戶未啟用？→ 403
  → 用戶無角色？→ 403
  → 用戶是 admin？→ 允許（繞過所有檢查）
  → 查詢 Permission 表（Method + Path 匹配）
  → Permission 不存在/已停用/無關聯角色？→ 403
  → 用戶角色在允許角色中？→ 允許
```

### 權限模組清單

#### monitor（監控管理）

| Feature | 功能 | 支援操作 |
|---------|------|----------|
| data_monitor | 數據監控 Dashboard | read |
| data_analysis | 數據分析報表 | read |
| alert_monitor | 告警監控 | read, create, update, delete |
| node_height_analysis | 節點高度分析 | read |
| monitor_merchant_asset | 商戶資產監控 | read |

#### block_chain（區塊鏈管理）

| Feature | 功能 | 支援操作 |
|---------|------|----------|
| chain | 鏈管理 | read, create, update, delete |
| token | 代幣管理 | read, create, update, delete |
| bank_code_mapping | 銀行代碼映射 | read, create, update, delete |
| market_price_trace | 市場價格追蹤 | read, create, update, delete |
| risk_address | 風險地址 | read, create, update, delete |

#### wallet（錢包管理）

| Feature | 功能 | 支援操作 |
|---------|------|----------|
| query | 錢包查詢 | read, create |
| details | 錢包詳情（餘額刷新、類型變更、批次操作、匯出） | read, update |
| secret_key | 私鑰匯出與匯出紀錄 | read |
| transfer | 錢包轉帳（發起、審核、紀錄查詢） | read, create, update |

#### order（訂單管理）

| Feature | 功能 | 支援操作 |
|---------|------|----------|
| deposit | 充值訂單 | read, create |
| withdraw | 提現訂單 | read, create, update |
| transfer | 轉帳單 | read, update |
| swap | 兌換訂單 | read, create |
| liquidity_pool | 流動池訂單 | read, create |
| transaction | 交易明細 | read |

#### finance（財務管理）

| Feature | 功能 | 支援操作 |
|---------|------|----------|
| reconciliation_statement_query | 對帳報表查詢 | read, update |
| wallet_yield_analysis | 錢包損益分析 | read |

#### system（系統管理）

| Feature | 功能 | 支援操作 |
|---------|------|----------|
| dns | DNS 紀錄管理 | read, create, delete |
| user | 用戶管理 | read, update |
| role | 角色管理（含角色限額設定） | read, create, update, delete |
| merchant | 商戶管理（含代幣設定、錢包同步） | read, create, update |

### 用戶狀態

| 值 | 說明 |
|----|------|
| 1 | 啟用 (UserStatusEnable) |
| 2 | 停用 (UserStatusDisable) |

---

## 9. 外部系統串接

### 串接總覽

| 外部系統 | 用途 | 資料流方向 | 套件位置 |
|----------|------|------------|----------|
| Cryp-Admin | 區塊鏈節點管理 | 雙向 | `kit/pkg/crypadmin/` |
| Cryp | 鏈上交易執行 | 雙向（含回調） | `kit/pkg/cryp/` |
| Keychain | 私鑰管理 | CAMS → Keychain | `kit/pkg/keychain/` |
| Binance | 代幣價格查詢 | CAMS ← Binance | `kit/pkg/exchange/` |
| MEXC | 代幣價格查詢 | CAMS ← MEXC | `kit/pkg/exchange/` |
| FameEx | 代幣價格查詢 | CAMS ← FameEx | `kit/pkg/exchange/` |
| TronScan | TRON 地址風險評估 | CAMS ← TronScan | `kit/pkg/riskprovider/` |
| OKX | 地址風險評估 | CAMS ← OKX | `kit/pkg/riskprovider/` |
| Space.ID | 域名服務 | CAMS → Space.ID | `kit/pkg/space_id/` |
| Google OAuth | 用戶認證 | 雙向 | config |
| RabbitMQ | 訊息佇列 | 內部 | `kit/lib/queue/` |
| Redis | 快取 | 內部 | `core/infra/cache/` |
| Elasticsearch | 日誌儲存 | CAMS → ES | `core/infra/log/` |

### Cryp-Admin（區塊鏈節點管理）

- **Client**：`kit/pkg/crypadmin/client/client.go`
- **API**：`GetNodeList()`, `CreateNode()`
- Domain 由 config 設定（dev: `http://cc.cams-dev.1-pay.co/cryp-admin`）
- 支援 Mock 模式

### Cryp（鏈上交易服務）

- **Client**：`kit/pkg/cryp/client/client.go`
- **API**：查詢合約詳情、估算手續費、取得區塊高度、建立追蹤鏈上交易
- **回調**：Handler `job/api/controller/cryp/handler/cryp/callback.go` → `ReceiveTransactionNotify()`

**回調資料 (TxnRawData)**：

| 欄位 | 說明 |
|------|------|
| OrderID | 平台訂單號 |
| TransferID | Transfer UUID |
| ChainType | 鏈類型 |
| CryptoType | 加密貨幣類型 |
| TxType | 1=充值/入帳, 2=提現/出款 |
| Action | normal, swap, lp |
| FromAddress / ToAddress | 來源/目標地址 |
| Amount / Fee | 金額/手續費 |
| Status | 交易狀態 |

**交易處理 Handler 對應**：

| TxType | Action | Handler |
|--------|--------|---------|
| 1 (充值) | normal/default | HandlerDepositTxn |
| 1 (充值) | swap | HandlerSwapToTxn |
| 1 (充值) | lp | HandlerLiquidityToTxn |
| 2 (提現) | normal/default | HandlerWithdrawTxn |
| 2 (提現) | swap | HandlerSwapFromTxn |
| 2 (提現) | lp | HandlerLiquidityFromTxn |

### 風險地址評估

| Provider | 適用場景 |
|----------|----------|
| TronScan | TRON 鏈地址風險評估 |
| OKX | 通用地址風險評估 |

回應含 `RedTag`（風險標籤）和 `IsRisk`（boolean）。充值交易入帳時自動檢查來源地址。

### 商戶通知 (Webhook)

| 類型 | 通知 URL 設定 | 觸發時機 |
|------|--------------|----------|
| 充值通知 | NotifyDepositURL | 充值到最終狀態 |
| 提現通知 | NotifyWithdrawURL | 提現到最終狀態 |
| 兌換通知 | NotifySwapURL | 兌換到最終狀態 |
| 流動池通知 | NotifyLiquidityPoolURL | 流動池到最終狀態 |
| 交易建立通知 | NotifyMapURL | TX ID 建立時（非必填） |

機制：簽名驗證（SecretKey）、重試、Redis 鎖（2 分鐘）、狀態追蹤

### RabbitMQ 訊息佇列

Exchange：`cams`（direct 類型，durable）

| Queue | Worker 數 | Prefetch | 用途 |
|-------|-----------|----------|------|
| withdraw.create_transfer | 20 | 30 | 建立提現轉帳單 |
| swap.create_transfer | 1 | 50 | 建立兌換轉帳單 |
| transfer.execute_transfer | 20 | 30 | 執行鏈上轉帳 |
| wallet.collection | 20 | 20 | 資金歸集 |
| wallet.distribution | 10 | 20 | 資金下發 |

---

## 10. 排程任務總覽

| 任務 | 頻率 | 模組 | 說明 |
|------|------|------|------|
| SyncPrice | 每 10 分鐘 | exchange | 同步交易所代幣價格 |
| HandleCollectFunds | 每 3 分鐘 | wallet_transfer | 執行資金歸集 |
| HandleDistributeFunds | 每 2 分鐘 | wallet_transfer | 執行資金下發 |
| HandlerTimeoutWalletTransfer | 每 10 分鐘 | wallet_transfer | 處理審核超時的錢包轉帳 |
| HandlerSnapshotWalletAsset | 每日 00:30 | report | 建立錢包資產快照 |
