# 商戶設定與管理

> **相關 Spec 參考**
> - [00-overview.md](../specs/00-overview.md) - 商戶管理模組總覽
> - [01-glossary.md](../specs/01-glossary.md) - Merchant、Notify、Slippage、BankTokenMapping 定義
> - [04-billing.md](../specs/04-billing.md) - 滑點設定與價格來源
> - [05-users-permissions.md](../specs/05-users-permissions.md) - system > merchant 權限
> - [06-integrations.md](../specs/06-integrations.md) - 商戶通知 Webhook 機制

> **ELK 查詢指引**
> - **cams-api**：商戶設定變更、功能啟停、代幣配置等 API 請求日誌
> - 常用搜尋欄位：`merchant_id`、`merchant_name`

## 適用情境

商戶功能啟停、通知設定、代幣設定、滑點調整、以及商戶相關問題排查。

---

## 情境一：商戶功能啟停

### 觸發條件

需要為商戶開啟或關閉特定功能（充值、提現、兌換、流動池）。

### 功能開關欄位

| 欄位 | 功能 | 影響 |
|------|------|------|
| DepositStatus | 充值功能 | 關閉後該商戶的用戶充值不處理 |
| WithdrawStatus | 提現功能 | 關閉後拒絕該商戶的提現請求 |
| SwapStatus | 兌換功能 | 關閉後拒絕該商戶的兌換請求 |
| LiquidityPoolStatus | 流動池功能 | 關閉後拒絕該商戶的流動池請求 |

### 操作方式

1. 透過後台「商戶管理」功能修改
2. 需要 `system > merchant > update` 權限
3. 變更立即生效

### 注意事項

- 關閉提現不影響已建立的提現訂單（進行中的訂單會繼續處理）
- 關閉充值後，鏈上交易仍可能到達用戶錢包，但不會建立 Deposit 訂單
- 建議在維護或異常時臨時關閉功能

---

## 情境二：商戶通知 URL 設定

### 觸發條件

商戶需要設定或修改 Webhook 通知 URL。

### 通知 URL 欄位

| 欄位 | 用途 | 必填 |
|------|------|------|
| NotifyDepositURL | 充值完成通知 | 建議設定 |
| NotifyWithdrawURL | 提現完成通知 | 建議設定 |
| NotifySwapURL | 兌換完成通知 | 視業務需求 |
| NotifyLiquidityPoolURL | 流動池完成通知 | 視業務需求 |
| NotifyMapURL | 交易建立通知（TX ID 建立時） | 非必填 |

### 設定要求

1. URL 必須為有效的 HTTP/HTTPS 端點
2. 商戶端需正確處理簽名驗證（使用 SecretKey）
3. 商戶端需回應 HTTP 200 表示接收成功
4. 未設定 URL 的通知類型 → NotifyStatus 為 4 (不需要通知)

### 簽名驗證機制

- 系統使用商戶的 `SecretKey` 計算通知內容的簽名
- 商戶端需用相同的 SecretKey 驗證 `sign` 欄位
- SecretKey 需妥善保管，不可外洩

---

## 情境三：商戶代幣設定

### 觸發條件

需要為商戶配置支援的代幣。

### 設定內容

1. **代幣啟用**
   - 選擇商戶支援的 Chain + Token 組合
   - 透過 BankTokenMapping 將商戶的 BankCode 對應到系統的 Chain + Token

2. **BankCode 映射**
   - 商戶使用 BankCode 標識幣種（如 `USDT_TRC20`）
   - 系統透過 BankTokenMapping 轉換為內部 ChainID + TokenID
   - 需要 `block_chain > bank_code_mapping` 權限

3. **錢包同步**
   - 設定代幣後需同步建立對應的錢包
   - 透過商戶管理中的「錢包同步」功能

---

## 情境四：滑點設定調整

### 觸發條件

商戶的兌換或流動池操作因滑點問題頻繁失敗。

### 設定欄位

| 欄位 | 說明 | 範例 |
|------|------|------|
| SwapSlippage | 兌換滑點容許百分比 | 0.5 = 0.5% |
| LiquidityPoolSlippage | 流動池滑點容許百分比 | 1.0 = 1.0% |

### 調整建議

| 狀況 | 建議 |
|------|------|
| 頻繁滑點失敗 | 適當提高滑點容許百分比 |
| 擔心價格偏差過大 | 降低滑點百分比，但可能增加失敗率 |
| 市場波動大時 | 臨時調高滑點，穩定後調回 |

### 注意事項

- 滑點設定過高可能導致商戶承受較大的價格偏差損失
- 滑點設定過低會導致交易成功率下降
- 建議根據代幣流動性和市場狀況動態調整

---

## 情境五：商戶提現重試設定

### 觸發條件

提現失敗後的重試行為需要調整。

### 設定欄位

| 欄位 | 說明 |
|------|------|
| WithdrawRetryCount | 提現失敗後最大重試次數 |

### 注意事項

- 設定為 0 表示不重試
- 每次重試會重新選擇提現錢包並執行鏈上轉帳
- 重試次數過多可能浪費 Gas 費用
- 建議設定 2-3 次為合理範圍

---

## 情境六：新商戶接入

### 接入步驟

1. **建立商戶**
   - 設定 MerchantID、SecretKey
   - 需要 `system > merchant > create` 權限

2. **設定功能開關**
   - 根據業務需求啟用充值/提現/兌換/流動池

3. **設定通知 URL**
   - 配置各類型的 Webhook 通知 URL

4. **配置代幣**
   - 設定 BankTokenMapping
   - 啟用需要支援的 Chain + Token

5. **同步錢包**
   - 為商戶建立各類型錢包

6. **設定滑點與重試**
   - 配置 SwapSlippage、LiquidityPoolSlippage
   - 配置 WithdrawRetryCount

7. **測試驗證**
   - 使用測試環境驗證充值、提現等流程
   - 確認通知回調正常接收
