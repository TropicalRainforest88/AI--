# Payment 取卡規則筆記

> 排查取卡問題時參考此文檔
> **⚠️ 程式邏輯在 `paymentpool`，不是 `payment`**

---

## 取卡流程 & Log 解讀

### 環境域名

> ⚠️ 以下以 **ol（正式）** 為例，其他環境請替換域名

| 環境 | pool 域名 |
|------|----------|
| ol（正式） | `pool.1-pay.co` |
| pre / beta | 替換對應域名 |

### 充值取卡完整流程

```
payment 收到充值請求
  ↓
1. 向 pool 取卡
   POST http://pool.1-pay.co/api/payment/getPayableBankcard
  ↓
2. payment 自行判斷取到的卡是否符合條件
  ↓
3. 符合 → 向 pool 建單
   POST http://pool.1-pay.co/api/payment
```

### 充值取卡：如何查 log

用 **PAY 單號** 查 ELK（index: pool-cn*），可以直接看到取卡歷程（即 `getPayableBankcard` 回傳的 log 陣列）。

### 提現取卡：如何查 log

向對方索取 **流水號 `request_id`** 或 **商戶單號 `platform_order`** 後，用 ELK 查詢（index: pool-cn*）。

提現取卡由 payment 向 pool 發出請求，pool 回傳取卡歷程（同格式）。最終 `Final` 即為篩選後的付款卡。

### 取卡歷程 log 解讀

每一條 log 格式：`"FilterName: 剩餘卡列表"`

- 每個 filter 後的卡列表 = **通過**該 filter 的卡（被過濾的是兩條之間的差集）
- `Init`：所有候選卡起始池
- 中間各 FilterName：依序對應文檔中的 filter/sorter
- `Final`：最終取到的卡

**排查步驟：找目標卡在哪一條 log 消失 → 對照該 Filter 規則找原因**

**充值取卡 log 順序範例：**
```
Init → MaintainingFilter → TodayUsableFilter → StorageFilter
     → ReceiveAmountFilter → RechargeSyncDisabledFilter
     → TransferPrioritySorter → NameBasedBankModePicker → Final
```

### 沒有 Final 的情況

log 中**沒有 Final** → 被 pool 的其他規則濾掉（非本文檔涵蓋的 filter）

排查方式：
1. 看 pool 回傳的 response（error message / code）
2. 或直接查 paymentpool 原始碼確認

---

## 「提現」取卡規則 - PaymentCardChooser

> filter 有先後順序，過濾完後再排序

### 完整執行順序

```
CardBaseHandler（8 filters）
  → PaymentThirdPartyHandler（1 filter）
  → WithdrawHandler（2 filters）
  → PaymentCardRechargeRecentHandler（1 filter，條件）
  → PaymentCardBusyHandler（1 filter）
  → PaymentCardPsMaintainHandler（1 filter）
  → PaymentSortHandler（排序，取第一張）
```

### CardBaseHandler

| # | Filter | 規則 |
|---|--------|------|
| 1 | **UserNameExclusionFilter** | 依 username 排除符合 `DataBankCardChooserExclusionRules` 表設定的卡（動態配置） |
| 2 | **MaintainingFilter** | 排除「開啟維護狀態，且正在維護區間」的卡片 |
| 3 | **TodayTransferTimeFilter** | 排除「轉出次數 ≥ 日/月最大轉帳筆數」的卡片 |
| 4 | **ToPrivateMonthlyFilter** | 排除「超過當月轉給私卡的總量」的卡片 |
| 5 | **QrcodeLoginBlockedFilter** | 排除「QRCode 登入且有待處理 QRCode」的卡片 |
| 6 | **NotAuctionFilter** | 排除 `Bank Card ID 為 AUCTION_PAYMENT_CARD` 的卡片 |
| 7 | **TargetBankFilter** | 有目標銀行卡時，排除「請求銀行別不同」的卡片 |
| 8 | **AuctionModeFilter**（條件） | 極速配對模式為支付寶/微信時，過濾非支付寶/微信的卡片（不含銀行卡） |

### PaymentThirdPartyHandler

| Filter | 規則 |
|--------|------|
| **ThirdPartyFilter** | 排除「被三方黑名單」的卡片 |

### WithdrawHandler

| Filter | 規則 |
|--------|------|
| **WithdrawLevelFilter** | 排除「Level 不在分組標籤內」的卡片 |
| **WithdrawCardTypeFilter** | 排除非提現卡片應取得的卡種（如聚合碼） |

### PaymentCardRechargeRecentHandler

| Filter | 規則 |
|--------|------|
| **BeenRechargeRecentlyFilter**（條件：有 targetCardNumber） | 有目標銀行卡時，排除「最近（未滿充值後可提現冷卻時間）曾收過款」的卡片 |

### PaymentCardBusyHandler

| Filter | 規則 |
|--------|------|
| **IsPaymentBusyFilter** | 排除「除轉帳測試單以外，單量超過同時轉出最大筆數」的卡片 → 調整方式：編輯銀行卡的同時可轉出餘額 |

### PaymentCardPsMaintainHandler

| Filter | 規則 |
|--------|------|
| **PsMaintainFilter** | 人行維護時，排除「非三方且請求銀行別相同」的卡片（極速支付寶/微信開啟時不受限） |

### PaymentSortHandler（排序）

排序優先順序：
1. 三方取卡優先
2. 提現給卡優先順序
3. 請求銀行別相同 > 不同
4. 清空標示有 > 無
5. 轉出次數少 > 多
6. 最後轉出時間（處理中）
7. 私卡 > 公卡

---

## 「充值」取卡規則 - RechargeCardChooser

### 整體流程

```
可用卡 → CardCommonHandler → CardSourceBankHandler → CardCapacityHandler
       → RechargeHandler → RechargeSorterHandler → RechargePickerHandler → 最後取卡
```

---

### CardCommonHandler（卡片共通規則）

| # | Filter | 規則 |
|---|--------|------|
| 1 | **UserNameExclusionFilter** | 依 username 排除符合 `DataBankCardChooserExclusionRules` 表設定的卡（動態配置） |
| 2 | **MaintainingFilter** | 排除「開啟維護狀態，且正在維護區間」的卡片 |
| 3 | **MachineFirstUsableFilter** | 只取同一個「主機代碼」的第一張卡 |
| 4 | **NoTestProcessingFilter** | 待補充規則說明 |
| 5 | **TodayTransferTimeFilter** | 排除「轉出次數 ≥ 日/月最大轉帳筆數」的卡片 |
| 6 | **IsAliveFilter** | 檢查心跳 |
| 7 | **BalanceKeepUpdatedFilter** | 逾期未從轉帳程式更新餘額 → 發出異常卡事件，重置更新餘額時間 |
| 8 | **TodayReceiveTimesFilter** | 排除「有設日收款最大筆數，且今日轉出次數已超出」的卡 |
| 9 | **QrcodeLoginBlockedFilter** | 排除「QRCode 登入且有待處理 QRCode」的卡片 |
| 10 | **BlackListFilter** | 排除實名制清單應忽略的卡片 |
| 11 | **CardNumberFilter** | 有指定卡號時，排除「非指定卡號」的卡片 |
| 12 | **CardTypeFilter** | 卡種為支付寶/微信時，過濾非支付寶/微信的卡片（不含銀行卡） |
| 13 | **RechargeTypeFilter** | 僅保留：加密貨幣卡、APP 支付卡、一般銀行帳號或信用卡（網關/非網關判斷） |
| 14 | **RechargeTargetBankFilter** | 有目標銀行卡時，排除「請求銀行別不同」的卡片 |
| 15 | **RechargeReachMaxTimeoutFilter**（條件：有 GOOGLE_CHAT_ID） | 排除最大連續逾時取消次數之異常卡（AI 線下充值場景） |

---

### CardSourceBankHandler

- **SourceBankFilter：** 有銀行碼且非 APP 充值時，排除「來源銀行受限的三方卡」

---

### CardCapacityHandler

| Filter | 規則 |
|--------|------|
| **TodayUsableFilter** | 排除「請求金額 ≥ 剩餘可轉出量或可用收款量」的卡片 |
| **StorageFilter** | 排除「超過可收款額度」或「餘額 ≥ 安全容量上限/儲存金額上限」的卡片 |
| **ReceiveAmountFilter** | 排除「有設收款區間波段，且請求金額超出區間」的卡片 |
| **ToPrivateMonthlyFilter** | 排除「超過當月轉給私卡的總量」的卡片 |

---

### RechargeHandler

| # | Filter | 規則 |
|---|--------|------|
| 1 | **RechargeLevelFilter** | 排除「Level 不在分組標籤內」的卡片 |
| 2 | **RechargeSyncDisabledFilter** | SYNC_DISABLED=0：過濾非同步三方；SYNC_DISABLED=1：允許非同步三方；SOURCE_BANK_CODE 為空時也過濾非同步三方 |
| 3 | **RechargeWhiteListFilter** | 有指定銀行卡時，排除「不在白名單內」的卡片 |
| 4 | **RechargeMaintenanceFilter** | 有 SOURCE_BANK_CODE 時，排除「該銀行別正在充值維護」的卡片 |
| 5 | **RechargeReachMaxFailCountFilter**（條件：有 orderId） | 同一張卡對同一訂單失敗達最大次數 → 跳過該卡 |

---

### RechargeSorterHandler（排序）

**有充值用戶ID（UserIdSorter）：**
1. 大額專卡優先
2. 花唄卡優先取卡層級
3. 支付寶/微信優先圖片格式
4. 渠道優先權（小 > 大）
5. 充值用戶記憶取卡（三方卡不套用）
6. 平台充值優先順序（RECHARGE_PRIORITY，小優先，最低 9999，預設 1000）
7. 單卡充值優先順序（RECHARGE_PRIORITY，小優先，最低 255，預設 255）
8. 清空標示（有 > 無）
9. 最後轉出時間(處理中) & 最後轉入時間(處理中) 取較早者
10. 銀行卡序號（小 → 大）

**無充值用戶ID（TransferPrioritySorter）：**
1. 大額專卡優先
2. 花唄卡優先取卡層級
3. 支付寶/微信優先圖片格式
4. 渠道優先權（小 > 大）
5. 平台充值優先順序
6. 微信/支付寶、金寶會員優先取卡層級
7. 平台充值優先順序（再次）
8. 單卡充值優先順序
9. 清空標示（有 > 無）
10. 最後轉出/轉入時間取較早者
11. 銀行卡序號（小 → 大）

**MapModeSorter（條件）：** 有指定「實名制銀行別及模式」且設定支/微最後取卡（LAST=true）時，依設定優先順序排序

---

### RechargePickerHandler（最後取卡）

**Picker 優先級（互斥，有符合且取到就結束）：**

| 優先級 | Picker | 觸發條件 | 說明 |
|--------|--------|---------|------|
| 1 | **NameBasedCardPicker** | `nameBasedCardIds` 清單不為空 | 從實名制限定卡列表中，取符合的第一張卡 |
| 2 | **NameBasedBankModePicker** | `nameBasedBankMapModes` 清單不為空 | 有實名制限定銀行別＋配對模式時，取符合的第一張卡 |
| 3 | **DuplicateCardAmountPicker** | `isTryLockAmount() === true` | 檢查沒有被「同卡同額」規則鎖住的卡，返回第一張 |

**RechargePickerFilter 額外規則（CAS-488）：**
- 逐卡執行 Picker 前，若卡片 `EXTRA_DATA.max_receive_count` 有設定，且目前處理中筆數已達上限 → 跳過該卡

**結果處理：**
- 無符合 Picker → 回傳原始排序後的卡片集合
- 有 Picker 但未取到任何卡 → 回傳空集合（取卡歷程顯示 Error）
