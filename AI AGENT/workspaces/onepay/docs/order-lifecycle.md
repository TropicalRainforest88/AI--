# 訂單全生命週期文檔

> 本文檔涵蓋 OnePay 充值/提現訂單的完整狀態機、流程全景、回調機制與排查指南。
> 受眾：AI Agent（OnePay AI PM）。

---

## 1. 訂單類型

| 類型 | 前綴 | 說明 |
|------|------|------|
| 充值單 | `PAY` | 用戶入金，資金從用戶銀行卡 → 平台銀行卡 |
| 提現單 | `WDR` | 用戶出金，資金從平台銀行卡 → 用戶銀行卡 |

兩種訂單在 Auction（極速）模式下會配對：一筆充值配對一筆（或多筆）提現。

---

## 2. 配對模式

| 模式 | 觸發條件 | 特徵 |
|------|----------|------|
| **搶單池** | 平台設定 `auctionWithdrawBreakMode` ≠ 3 | 一對一，充值金額 = 提現金額 |
| **餘額池** | 平台設定 `auctionWithdrawBreakMode` = 3 | 多對一，多筆充值金額加總 = 提現金額 |

---

## 3. 充值訂單狀態機

### 3.1 狀態碼一覽

| 碼 | 名稱 | 類型 | 說明 |
|----|------|------|------|
| 0 | WAIT | 通用 | 初始狀態，等待處理 |
| 1 | IN_PROCESS | 通用 | 處理中，已取到卡/正在付款 |
| 2 | SUCCESS | 通用 | 成功（終態） |
| 3 | FAIL | 通用 | 失敗（終態） |
| 4 | UNKNOWN | 通用 | 未知狀態（異常，不應出現） |
| 5 | TIMEOUT | 通用 | 超時（終態） |
| 6 | NO_BANKCARD | 通用 | 無可用銀行卡（終態） |
| 7 | ATTEMPT_TO_MANY_TIMES | 通用 | 嘗試次數過多（終態） |
| 8 | NO_LEVEL_BANKCARD | 通用 | 無閒置銀行卡可用（終態） |
| 10 | PREVIEW | Auction | 待審核（用戶已上傳憑證，等運營審核） |
| 11 | CANCEL | Auction | 已取消 |
| 12 | WAIT_MAPPING | Auction | 等待配對提現單 |
| 13 | WITHDRAW_PREVIEW | Auction | 等待提現審核（配對的提現單在審核中） |
| 14 | WAIT_AUTO_PAIR | Auction | 自動配對中（初次配卡被拒或 WAIT_MAPPING 超時後的 fallback） |
| 15 | PREVIEW_TIMEOUT | Auction | 審核超時 |
| 21 | WAIT_THIRDPARTY_RESPONSE | Auction | 等待三方異步取卡回應 |
| 22 | PREVIEW_BY_MANUAL | Auction | 人工審核中（姓名比對不一致） |
| 31 | FAIL_BY_CANCEL | Auction | 取消導致失敗（終態） |
| 32 | FAIL_BY_CANCEL_WAIT | Auction | 等待中取消失敗（終態） |
| 33 | PH_FIRST_REVIEW | Auction | 菲籍一審中（運營審核） |
| 34 | PH_FIRST_REVIEW_TIMEOUT | Auction | 菲籍一審超時 |

**終態**：2, 3, 4, 5, 6, 7, 8, 11, 31, 32 — 到達後不再變更。

**處理中態**（統稱「進行中」）：0, 1, 10, 12, 13, 14, 15, 21, 22, 33, 34。

### 3.2 狀態流轉圖

#### 3.2.1 通用充值流程（非 Auction）

```
WAIT(0) ──取到卡──→ IN_PROCESS(1) ──明細匹配──→ SUCCESS(2)
  │                       │
  │                       ├──姓名不符──→ PREVIEW_BY_MANUAL(22)──審核通過──→ SUCCESS(2)
  │                       │                                    └──審核拒絕──→ FAIL(3)
  │                       └──超時──→ FAIL(3)
  │
  ├──無卡──→ NO_BANKCARD(6)
  ├──無閒置卡──→ NO_LEVEL_BANKCARD(8)
  └──嘗試過多──→ ATTEMPT_TO_MANY_TIMES(7)
```

#### 3.2.2 Auction 充值流程（搶單池）

```
WAIT(0)
  └──建單成功──→ WAIT_MAPPING(12) ──配對成功──→ IN_PROCESS(1)
                       │                           │
                       │                           ├──用戶上傳憑證──→ PREVIEW(10)──審核通過──→ SUCCESS(2)
                       │                           │                              └──審核超時──→ PREVIEW_TIMEOUT(15)
                       │                           │
                       │                           ├──菲籍一審──→ PH_FIRST_REVIEW(33)──通過──→ SUCCESS(2)
                       │                           │                                   └──超時──→ PH_FIRST_REVIEW_TIMEOUT(34)
                       │                           │
                       │                           ├──提現進入審核──→ WITHDRAW_PREVIEW(13)──24小時超時──→ FAIL(3)
                       │                           │
                       │                           └──三方異步卡──→ WAIT_THIRDPARTY_RESPONSE(21)──回應──→ IN_PROCESS(1)
                       │                                                                         └──超時──→ FAIL(3)
                       │
                       ├──超時（允許 fallback）──→ WAIT_AUTO_PAIR(14) ──自動配卡成功──→ IN_PROCESS(1)
                       │                                              └──仍超時──→ FAIL(3)
                       │
                       └──超時（不允許 fallback）──→ FAIL(3)

WAIT(0) / 建單時
  └──初次配卡被拒（極速充值是否允許配卡=否）──→ WAIT_AUTO_PAIR(14)
       └──排延遲任務（~2秒）──→ 重試配卡
            ├──配卡成功──→ IN_PROCESS(1)
            └──仍無卡──→ 可能再重試 或 FAIL(3)
```

> **⚠️ WAIT_AUTO_PAIR 與前端空白頁**：進入 WAIT_AUTO_PAIR(14) 時，系統會先推一次 WebSocket（`streamer emit`），此時**無卡片資訊**，前端頁面顯示空白。延遲任務配卡成功後會推第二次帶完整卡片資訊。若前端未正確接收第二次推送（連線中斷、前端未監聽 update 事件），用戶會一直看到空白頁。排查此類問題參考 `elk-keywords.md` 情境 24。

#### 3.2.3 用戶取消重試

任何進行中狀態 → `FAIL_BY_CANCEL(31)`（釋放池資源，可生成新的 merchants_order 重試）
WAIT_MAPPING(12) 等待中取消 → `FAIL_BY_CANCEL_WAIT(32)`（等待配對期間被取消）

### 3.3 觸發方法對照

| 狀態轉換 | 觸發服務/方法 |
|---------|------------|
| → WAIT | `RechargeOrderRepository::createOrder()` |
| → WAIT_MAPPING | `RechargeOrderRepository::createAuctionIframeOrder()` |
| WAIT → IN_PROCESS | `RechargeOrderRepository::updateRechargeCardByRechargeId()` |
| IN_PROCESS → SUCCESS | `Step2Facade::setSuccess()` |
| IN_PROCESS → PREVIEW_BY_MANUAL | `Step2Facade`（姓名不符時） |
| IN_PROCESS → PREVIEW | `RechargePreviewService::updatePreview()` |
| WAIT_MAPPING → WAIT_AUTO_PAIR | `TimeoutFacade::onWaitMapping()` |
| WAIT_MAPPING → FAIL | `TimeoutFacade::releasePoolAndSetFail()` |
| → FAIL_BY_CANCEL | `CancelRetryPayService::execute()` |
| → TIMEOUT | `TimeoutFacade`（各 onXxx 方法） |

---

## 4. 提現訂單狀態機

### 4.1 狀態碼一覽

| 碼 | 名稱 | 類型 | 說明 |
|----|------|------|------|
| 0 | INIT | 通用 | 初始化 |
| 1 | IN_PROCESS | 通用 | 處理中（已派卡、正在轉帳） |
| 2 | SUCCESS | 通用 | 成功（終態） |
| 3 | ERROR | 通用 | 失敗（終態） |
| 4 | ERROR_RETRY | 通用 | 失敗重試中 |
| 5 | TIMEOUT | 通用 | 超時（終態） |
| 6 | NO_CARD | 通用 | 沒有可用卡（終態） |
| 7 | WAITING | 通用 | 排隊等候中（平台開啟了等待功能） |
| 8 | CASH_POOL_BUSY | 通用 | 資金池忙碌（終態） |
| 9 | IN_PROCESS_WARNING | 通用 | 處理中 — 等待網銀更新狀態（需人工確認） |
| 10 | MANUAL_CONFIRM | 通用 | 人工確認中 |
| 11 | NO_LEVEL_CARD | 通用 | 無閒置銀行卡可用（終態） |
| 12 | CANCEL_WARNING | 通用 | 取消警告（部分金額已成功） |
| 13 | WAIT_MAPPING | Auction | 等待配對充值單 |
| 14 | PREVIEW | Auction | 待審核（配對的充值進入審核） |
| 15 | AUCTION_MANUAL_CONFIRM | Auction | 人工確認(極速模式) |

**終態**：2, 3, 5, 6, 8, 11。

**處理中態**：0, 1, 4, 7, 9, 10, 12, 13, 14, 15。

**允許重試的狀態**：1 (IN_PROCESS)、9 (IN_PROCESS_WARNING)、12 (CANCEL_WARNING)。

### 4.2 狀態流轉圖

#### 4.2.1 通用提現流程

```
INIT(0) ──取卡成功──→ IN_PROCESS(1) ──轉帳成功──→ SUCCESS(2)
  │                       │
  │                       ├──轉帳失敗──→ ERROR(3)
  │                       │
  │                       ├──部分成功──→ CANCEL_WARNING(12) ──確認──→ SUCCESS(2) 或 ERROR(3)
  │                       │
  │                       ├──等待網銀──→ IN_PROCESS_WARNING(9) ──確認──→ SUCCESS(2) 或 ERROR(3)
  │                       │
  │                       └──需人工──→ MANUAL_CONFIRM(10) ──確認──→ SUCCESS(2) 或 ERROR(3)
  │
  ├──排隊等候──→ WAITING(7) ──喚醒──→ IN_PROCESS(1) 或 WAIT_MAPPING(13)
  │                          └──超時──→ TIMEOUT(5)
  │                          └──黑名單──→ NO_CARD(6)
  │
  ├──無卡──→ NO_CARD(6)
  ├──無閒置卡──→ NO_LEVEL_CARD(11)
  └──資金池忙──→ CASH_POOL_BUSY(8)
```

#### 4.2.2 Auction 提現流程

```
INIT(0)
  └──進入配對──→ WAIT_MAPPING(13) ──配對充值單──→ IN_PROCESS(1) ──轉帳成功──→ SUCCESS(2)
                       │                              │
                       │                              ├──充值進入審核──→ PREVIEW(14)──審核通過──→ SUCCESS(2)
                       │                              │
                       │                              └──需人工確認──→ AUCTION_MANUAL_CONFIRM(15)
                       │
                       └──超時/失敗──→ TIMEOUT(5) 或 ERROR(3)
```

#### 4.2.3 失敗重試流程

```
IN_PROCESS(1) 或 ERROR(3) ──cron 觸發──→ ERROR_RETRY(4)
                                              │
                                              ├──重試成功──→ IN_PROCESS(1)──→ SUCCESS(2)
                                              ├──黑名單（有部分金額）──→ CANCEL_WARNING(12)
                                              ├──黑名單（無金額）──→ ERROR(3)
                                              └──重試超時──→ TIMEOUT(5)
```

### 4.3 觸發方法對照

| 狀態轉換 | 觸發服務/方法 |
|---------|------------|
| → INIT | `WithdrawOrderRepository::createOrder()` |
| INIT → WAITING | `CreateFacade::pushToWaiting()` |
| INIT → IN_PROCESS | `CreateFacade::createPoolOrder()` |
| INIT → WAIT_MAPPING | `CreateFacade::createPoolOrder()`（Auction） |
| WAITING → IN_PROCESS | `WaitingFacade::run()`（cron 喚醒） |
| IN_PROCESS → SUCCESS | `WithdrawCheckFacade::run()` |
| IN_PROCESS → ERROR | `WithdrawCheckFacade::run()` |
| → ERROR_RETRY | `WithdrawDispatchService::dispatch()`（cron） |
| ERROR_RETRY → IN_PROCESS | `RetryFacade::onCashpoolOk()` |
| ERROR_RETRY → ERROR | `RetryFacade::onCashpool517()` |

---

## 5. 輔助狀態欄位

### 5.1 審核狀態（Review Status）

充值與提現共用同一套：

| 碼 | 狀態 | 說明 |
|----|------|------|
| 1 | REVIEWING | 審核進行中 |
| 2 | SUCCESS | 審核通過 |
| 3 | FAILURE | 審核拒絕 |
| 5 | TERMINATED | 審核終止 |

### 5.2 回調通知狀態（Notify Status）

充值 (`RechargeNotifyStatus`)：

| 碼 | 狀態 | 說明 |
|----|------|------|
| 0 | INIT | 未通知 |
| 1 | WAIT | 等待通知 |
| 2 | FAIL | 通知失敗（已達最大重試） |
| 3 | SUCCESS | 通知成功 |
| 4 | FAIL_RETRY | 失敗重試中 |
| 5 | FAIL_URL | URL 異常，終止通知 |
| 6 | ALREADY_SUCCESS | 配對前已成功通知 |
| 7 | MAPPING_SUCCESS | 配對成功通知 |
| 8 | TERMINATE | 手動終止 |

提現 (`WithdrawNotifyStatus`)：

| 碼 | 狀態 | 說明 |
|----|------|------|
| 0 | INIT | 未通知 |
| 1 | WAIT | 等待通知 |
| 2 | FAIL | 通知失敗 |
| 3 | SUCCESS | 通知成功 |
| 4 | FAIL_RETRY | 失敗重試中 |
| 5 | FAIL_URL | URL 異常，終止 |
| 7 | MAPPING_SUCCESS | 配對成功通知 |
| 8 | PREVIEW_SUCCESS | 審核通過通知 |
| 9 | TERMINATE | 手動終止 |

### 5.3 充值驗證方式（Check Status）

記錄該筆充值是如何被驗證的：

| 碼 | 方式 | 說明 |
|----|------|------|
| 1 | AUTO | 系統自動驗證 |
| 2 | MANUAL_BY_RECORD | 人工 — 銀行流水比對 |
| 3 | MANUAL_BY_AMOUNT | 人工 — 金額匹配 |
| 4 | MANUAL_BY_SMS | 人工 — 簡訊匹配 |
| 5 | MANUAL_BY_WECHAT | 人工 — 微信帳單匹配 |
| 6 | MANUAL_BY_CREDIT_RATING | 人工 — 信用評級 |
| 7 | AUTO_BY_RECEIPT | 自動 — 回單比對 |
| 8 | AUTO_BY_IMAGE_REGEX | 自動 — 圖片 OCR 正則 |
| 9 | AUTO_BY_CREDIT_SCORE | 自動 — 信用評分 |
| 10 | AUTO_BY_RECEIPT_TO_CREDIT_SCORE | 自動 — 回單→信用評分 |
| 11 | AUTO_BY_TG | 自動 — TG 驗證 |
| 23 | AUTO_BY_GUARANTEE | 自動 — 擔保模式 |

### 5.4 餘額池拆單狀態（Break Status）

僅適用於 `auctionWithdrawBreakMode = 3`（餘額池）：

| 碼 | 狀態 | 說明 |
|----|------|------|
| 0 | WAIT | 等待中 |
| 1 | PLATFORM_REVIEW | 平台審核 |
| 2 | IN_PROCESS | 處理中 |
| 3 | USER_PREVIEW | 用戶預覽/確認 |
| 4 | SUCCESS | 拆單成功 |
| 5 | FAIL | 拆單失敗 |
| 6 | USER_PREVIEW_DONE | 用戶預覽完成 |
| 7 | USER_PREVIEW_OVER | 用戶預覽超時 |
| 8 | WAIT_BREAK_RISK | 等待風控通過 |
| 9 | WAIT_BREAK | 等待充值配對 |
| 10 | TERMINATE | 終止（內部使用） |

ELK 判斷方式（僅供參考）：`break_list[0].status` 為 `WAIT(0)` = 搶單池，`WAIT_BREAK_RISK(8)` 或 `WAIT_BREAK(9)` = 餘額池。
> ⚠️ `break_list[0].status` 在實際操作中**不可靠**，僅反映設計值。操作時請用 `change_logs.break_mode` + 雙重確認流程判斷，詳見 `pm-ops-spec.md` Workflow 2 Step 2。

---

## 6. 回調（Notify）機制

### 6.1 觸發時機

| 事件 | 觸發回調 |
|------|---------|
| 充值狀態變為 SUCCESS 或 FAIL | 是 |
| 充值 IN_PROCESS 且 MAPPING 模式 | 是（帶 orderurl） |
| 提現狀態變為 SUCCESS 或 ERROR | 是 |
| 超時導致狀態變更 | 是 |

### 6.2 重試策略

| 項目 | 值 |
|------|---|
| 最大重試次數 | **20 次** |
| 重試間隔 | **固定 300 秒（5 分鐘）** |
| 退避策略 | **無**（固定間隔，非指數退避） |
| 最大重試總時長 | 約 100 分鐘 |
| URL 異常處理 | HTTP 非 2xx → `FAIL_URL`，**立即停止** |
| 成功判斷 | 商戶回應 body = `"OK"` |
| Job 超時 | 180 秒（單次執行） |
| 提現 Job 唯一性 | 24 小時內同一單不重複排隊 |

### 6.3 回調狀態流轉

```
INIT(0) ──訂單狀態變更──→ WAIT(1) ──Job 發送──→ 商戶回應 OK → SUCCESS(3)
                                       │
                                       ├──回應非 OK 但 HTTP 2xx → FAIL_RETRY(4) ──5分鐘後重試──→ ...（最多20次）
                                       │                                                         └──20次用盡──→ FAIL(2)
                                       │
                                       └──HTTP 非 2xx → FAIL_URL(5)（立即停止）
```

### 6.4 回調簽名算法

**充值回調簽名**：
```
sign = md5(memberid + orderid + merchant_order + amount + datetime + returncode + secret_key)
```

**提現回調簽名**：
```
sign = md5(memberid + orderid + withdraw_order + amount + datetime + returncode + secret_key)
```

### 6.5 returncode 對照

**充值**：

| 碼 | 訂單狀態 |
|----|---------|
| 00 | SUCCESS |
| 03 | FAIL / FAIL_BY_CANCEL |
| 11 | IN_PROCESS（MAPPING 模式） |
| 06 | 其他 |

**提現**：returncode 邏輯與充值類似，依訂單最終狀態決定。

---

## 7. 超時機制

### 7.1 超時檢查方式

由 `RechargeAuctionTimeoutCheckJob`（充值）和 `AuctionDetailTimeoutFacade`（提現）定時檢查。
Job 在訂單進入等待狀態時被排隊，通過 `nextCheckTime()` 自我重新排程。

### 7.2 各狀態超時配置

| 狀態 | 超時來源 | 說明 |
|------|---------|------|
| WAIT_MAPPING (充值12) | `AuctionRechargeTool::getCancelLimitTime()` | 平台配置 |
| PREVIEW (充值10) | `AuctionRechargeTool::getRechargeTimeoutTime()` | 平台配置 |
| PH_FIRST_REVIEW (充值33) | 同上 | 平台配置 |
| WITHDRAW_PREVIEW (充值13) | `create_time + 1 天` | 固定 24 小時 |
| WAIT_THIRDPARTY_RESPONSE (充值21) | `AuctionRechargeTool::getExpiredTime()` | 平台配置 |
| WAITING (提現7) | `WaitingFacade::detectExpired()` | 平台配置 |
| 提現 Auction 審核 | `auction_confirm_time` | 平台配置 |

> 超時值為**平台級配置**，每個平台（memberid）可設不同值，在後台管理頁面設定。

---

## 8. 排查指南

### 8.1 充值卡在某個狀態不動

| 停滯狀態 | 排查方向 |
|---------|---------|
| WAIT(0) | 取卡失敗 → 查 `getPayableBankcard` log，參考 `payment-card-chooser.md` |
| WAIT_MAPPING(12) | 無匹配的提現單 → 查是否有同金額的 WDR 在等待配對 |
| IN_PROCESS(1) | 等待用戶付款或明細匹配 → 查 Step2 log |
| PREVIEW(10) | 等待運營審核 → 聯繫運營 |
| WAIT_THIRDPARTY_RESPONSE(21) | 三方未回應 → 查三方連線 log |
| WITHDRAW_PREVIEW(13) | 配對的 WDR 在審核中 → 查 WDR 狀態 |

### 8.2 提現卡在某個狀態不動

| 停滯狀態 | 排查方向 |
|---------|---------|
| INIT(0) | 取卡/建單失敗 → 查 PaymentCardChooser log |
| WAITING(7) | 排隊中 → 查平台等待佇列是否正常消化 |
| WAIT_MAPPING(13) | 無匹配的充值單 → 需建立充值單配對（Workflow 2） |
| IN_PROCESS(1) | 轉帳中 → 查 cashpool 狀態 |
| ERROR_RETRY(4) | 重試中 → 查重試次數和 cashpool 回應 |
| IN_PROCESS_WARNING(9) | 等網銀確認 → 需人工查網銀後台 |
| CANCEL_WARNING(12) | 部分成功 → 需人工確認實際到帳金額 |

### 8.3 回調未送達

| 通知狀態 | 排查方向 |
|---------|---------|
| INIT(0) | 訂單尚未到達觸發回調的狀態 |
| WAIT(1) | Job 已排隊但尚未執行 → 查 queue worker |
| FAIL_RETRY(4) | 商戶回應非 OK → 查 `notify_plat_times` 看重試次數 |
| FAIL(2) | 20 次重試全失敗 → 聯繫商戶確認 notifyurl |
| FAIL_URL(5) | 商戶 URL 不通 → 聯繫商戶修復 URL |

### 8.4 ELK 查詢建議

訂單排查時，用以下識別符做 OR 查詢以覆蓋完整鏈路：

```
PAY單號 OR 商戶單號 OR userid OR 流水號
```

配合 `elk-keywords.md` 中對應情境的關鍵字縮小範圍。

---

## 9. 訂單查詢 API 狀態顯示名對照

> 以下為 `/api/ai/exec` 的 RechargeCheck 返回的 `status` 欄位值，從 `resources/lang/zh-CH/recharge.php` 源碼驗證。
> 此表供參考。操作流程中 AI Agent 可直接判讀 API 返回的中文狀態名，**不需查閱此表**。

### 9.1 充值狀態顯示名（RechargeCheck）

| 碼 | API 返回 status | enum | 終態 |
|----|----------------|------|------|
| 0 | 待處理 | WAIT | |
| 1 | 系統查核中 | IN_PROCESS | |
| 2 | 已充值 | SUCCESS | ✅ |
| 3 | 未充值 | FAIL | ✅ |
| 4 | 充值異常 | UNKNOWN | ✅ |
| 5 | 充值異常 | TIMEOUT | ✅ |
| 6 | 系統忙碌未收單 | NO_BANKCARD | ✅ |
| 7 | 超過頻率限制 | ATTEMPT_TO_MANY_TIMES | ✅ |
| 8 | 系統忙碌未收單(無對應分級) | NO_LEVEL_BANKCARD | ✅ |
| 10 | 審核中 | PREVIEW | |
| 11 | 取消 | CANCEL | ✅ |
| 12 | 等待配對 | WAIT_MAPPING | |
| 13 | 提現申請審核中 | WITHDRAW_PREVIEW | |
| 14 | 等待自動配卡 | WAIT_AUTO_PAIR | |
| 15 | 審核中(已超時) | PREVIEW_TIMEOUT | |
| 21 | 等待三方配卡回應 | WAIT_THIRDPARTY_RESPONSE | |
| 22 | 明細無姓名或異名-審核中 | PREVIEW_BY_MANUAL | |
| 31 | 未充值-用户取消 | FAIL_BY_CANCEL | ✅ |
| 32 | 未充值-等待中取消 | FAIL_BY_CANCEL_WAIT | ✅ |
| 33 | 菲籍一審 | PH_FIRST_REVIEW | |
| 34 | 菲籍一審(已超時) | PH_FIRST_REVIEW_TIMEOUT | |

**終態判斷規則**：status 含「已充值」「金額補單」「未充值」「取消」「充值異常」「系統忙碌」「超過頻率」任一即為終態。

> ⚠️ `金額補單(Ai)` 是 AI 人工補單後的顯示名，代表成功終態，不在標準 enum 映射表中但會出現在 RechargeCheck 回應。

### 9.2 提現狀態顯示名（WithdrawCheck，待實作）

> ⚠️ WithdrawCheck 尚未實作。以下顯示名從 `resources/lang/zh-CH/withdraw.php` 提取，
> 但 lang 檔使用 `WithdrawViewEnum`（非 `WithdrawEnum`），數值映射待 API 實作後驗證。

| 顯示名 | WithdrawViewEnum | 終態 |
|--------|-----------------|------|
| 待處理 | INIT | |
| 提現完成 | SUCCESS | ✅ |
| 處理中 | IN_PROCESS | |
| 系統忙碌未收單 | NO_CARD | ✅ |
| 系統忙碌未收單(無對應分級) | NO_LEVEL_CARD | ✅ |
| 無閒置銀行卡可用 | CASH_POOL_BUSY | ✅ |
| 提現異常 | ERROR | ✅ |
| 提現異常重試中 | ERROR_RETRY | |
| 提現異常-等待逾時 | TIMEOUT | ✅ |
| 等待中 | WAITING | |
| 處理中-等待網銀更新狀態 | IN_PROCESS_WARNING | |
| 取消-等待人工確認 | CANCEL_WARNING | |
| 等待配對 | WAIT_MAPPING | |
| 審核中 | PREVIEW | |
| 極速提現逾時 | AUCTION_MANUAL_CONFIRM | |
| 訂單逾時需人工確認 | MANUAL_CONFIRM | |
| 人工提現審核中 | REVIEWING | |
| 人工提現駁回 | REVIEW_FAIL | |

---

## 10. 關鍵源碼對照

| 模組 | 檔案路徑 | 說明 |
|------|---------|------|
| 充值狀態枚舉 | `payment/app/Enum/RechargeStatus.php` | 所有充值狀態碼定義 |
| 提現狀態枚舉 | `payment/app/Enum/WithdrawEnum.php` | 所有提現狀態碼定義 |
| 充值通知枚舉 | `payment/app/Enum/RechargeNotifyStatus.php` | 回調通知狀態 |
| 提現通知枚舉 | `payment/app/Enum/WithdrawNotifyStatus.php` | 回調通知狀態 |
| 充值建單 | `payment/app/Repositories/RechargeOrderRepository.php` | createOrder, createAuctionIframeOrder |
| 提現建單 | `payment/app/Repositories/WithdrawOrderRepository.php` | createOrder |
| 充值明細匹配 | `payment/app/Service/Recharge/Flow/Step2Facade.php` | setSuccess, 姓名比對 |
| 充值超時處理 | `payment/app/Service/Recharge/Flow/TimeoutFacade.php` | 各狀態超時轉換 |
| 充值自動配對 | `payment/app/Service/Recharge/Flow/WaitingPairFacade.php` | WAIT_AUTO_PAIR 流程 |
| 充值審核 | `payment/app/Service/Recharge/RechargePreviewService.php` | 上傳憑證/審核 |
| 充值取消重試 | `payment/app/Service/Recharge/CancelRetryPayService.php` | FAIL_BY_CANCEL |
| 提現建單流程 | `payment/app/Service/Withdraw/Flow/CreateFacade.php` | 取卡、排隊、配對 |
| 提現等候喚醒 | `payment/app/Service/Withdraw/Flow/WaitingFacade.php` | cron 喚醒排隊 |
| 提現重試 | `payment/app/Service/Withdraw/Flow/RetryFacade.php` | ERROR_RETRY 流程 |
| 提現確認 | `payment/app/Service/Withdraw/Flow/WithdrawCheckFacade.php` | cashpool 回報處理 |
| 充值回調 Job | `payment/app/Jobs/RechargeNotify.php` | 回調發送、簽名、重試 |
| 提現回調 Job | `payment/app/Jobs/WithdrawNotify.php` | 回調發送、簽名、重試 |
| 超時檢查 Job | `payment/app/Jobs/Recharge/RechargeAuctionTimeoutCheckJob.php` | 定時超時檢查 |
