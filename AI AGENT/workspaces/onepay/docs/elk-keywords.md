# OnePay ELK 日誌關鍵字情境對照表

> 來源：從各服務原始碼中直接提取的實際 log 訊息
> 用途：AI Agent 查詢 ELK 時的關鍵字依據 / 人工排查時的快速參考

## ELK 連線資訊

| 項目 | 值 |
|------|------|
| Elasticsearch URL | `http://onepay-kibana.1-pay.co:9200` |
| 認證方式 | Basic Auth（`$ELK_USER` / `$ELK_PASS`；若環境變數未設定，讀 `~/.openclaw/secrets/elk.sh` 取得帳密，禁止自行猜測或填寫任何密碼） |
| 時間欄位 | `datetime`（+08:00）為主；`ph-ol-risk-api` 只有 `@timestamp`（UTC） |

> ⚠️ **所有環境（pre / ol / beta）共用同一組帳密**，只需切換 index 前綴即可查詢，不需要額外權限。

> ELK Index 對照：
> - paymentpool → `ph-ol-pool-cn*`（pre: `pre-pool-cn*`，beta: `beta-pool-cn*`）⚠️ 加 `*`，近期資料在日期分區 index（如 `ph-ol-pool-cn-2026.03.21`）
> - risk_api → `ph-ol-risk-api`（pre: `pre-risk-api`，beta: `beta-risk-api`）
> - channel/infogen/payment-flow → `ph-ol-channel-cn*`（pre: `pre-channel-cn*`，beta: `beta-channel-cn*`）
> - payment（人工補單/變更卡等管理操作）→ `ph-ol-payment-cn`（pre: `pre-payment-cn`，beta: `beta-payment-cn`）

## AuctionWithdrawBreakStatus 枚舉值對照

> 來源：`payment/app/Enum/AuctionWithdrawBreakStatus.php`
> 用途：ELK `cache_withdraw_order` 的 `break_list[0].status`（路由狀態）與 `change_logs.break_list` 中的整數值對照

| 整數值 | 枚舉名稱 | 意義 |
|--------|---------|------|
| 0 | WAIT | 搶單池待配對 |
| 1 | PLATFORM_REVIEW | 集團風控審核中（需審批通過才能配對） |
| 2 | IN_PROCESS | 配對處理中 |
| 3 | USER_PREVIEW | 使用者預覽中 |
| 4 | SUCCESS | 配對成功（已結算，含配卡結算路徑） |
| 5 | FAIL | 配對失敗 |
| 6 | USER_PREVIEW_DONE | 使用者預覽完成 |
| 7 | USER_PREVIEW_OVER | 使用者預覽逾時 |
| 8 | WAIT_BREAK_RISK | 餘額池待配對（集團風控等待）|
| 9 | WAIT_BREAK | 餘額池待配對（一般）|
| 10 | TERMINATE | 終止 |

> ⚠️ **注意事項**：
> - `break_list[0].status`（此表）= 池路由狀態，**≠** `change_logs.status`（提現訂單終態：2=已成功，3=失敗）
> - 搶單池標誌：`break_list[0].status` = 0（WAIT）
> - 餘額池標誌：`break_list[0].status` = 8（WAIT_BREAK_RISK）或 9（WAIT_BREAK）
> - 判斷是否仍在集團風控審核：找 ELK **最新一筆**含 `change_logs.break_list` 欄位的 log（取 `@timestamp` 最大），確認最新值含 `"status":1` → 仍審中；若為 `"status":0` 等其他值 → 已放行，**勿誤判**
> - 配卡結算（tx_withdraw 路徑）：status=4（SUCCESS），此時非 PAY 充值單配對，而是由人工審批 tx_withdraw 記錄結算。ELK 特徵：`bankcard_chk_times` 遞增，`chk_user` 有值（人工審批員 ID）

---

## 情境 1：充值（搶單/極速）失敗

**觸發場景：** 使用者充值後系統未完成配對，或配卡過程出錯

**ELK 查詢關鍵字：**

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `充值單: %s 領單失敗` | ERROR | 搶單失敗，order 無法被領取 | ph-ol-pool-cn* |
| `channel %s create recharge failed cause` | WARNING/NOTICE | 特定 channel 建立充值單失敗 | ph-ol-pool-cn* |
| `ThirdPartyFilter 過濾後無可用卡片` | WARNING/INFO | 卡池過濾後無可用卡 | ph-ol-pool-cn* |
| `搶單充值建單請求失敗` | ERROR | infogen 呼叫 payment 建單 API 失敗 | ph-ol-channel-cn* |
| `取得商戶ID失敗` | ERROR | 中間站搶單時無法取得商戶 ID，建單中斷 | ph-ol-channel-cn* |
| `極速充值三方回應配卡失敗` | ERROR | 三方回應後配卡失敗 | ph-ol-channel-cn* |
| `極速充值三方回應成功, 但訂單已是處理中` | ERROR | 重複回應，訂單狀態異常 | ph-ol-channel-cn* |
| `充值搶單通知資金池更新狀態失敗` | ERROR | 充值完成但通知 paymentpool 失敗 | ph-ol-channel-cn* |

**排查步驟：**
1. 先查 `ThirdPartyFilter 過濾後無可用卡片` → 確認卡池是否耗盡
2. 若有卡但仍失敗，查 `channel %s create recharge failed` → 確認是哪個 channel 出錯
3. 若 infogen 這層就失敗，查 `搶單充值建單請求失敗` → 可能是 payment 服務異常

---

## 情境 2：提現（搶單/極速）失敗

**觸發場景：** 使用者提現申請後未收到款項，或配對失敗

**ELK 查詢關鍵字：**

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `極速提現配對失敗轉提現先決` | WARNING | 極速提現配對失敗，退回普通流程 | ph-ol-channel-cn* |
| `極速提現建單失敗` | WARNING | 極速提現無法建立訂單 | ph-ol-channel-cn* |
| `等待配對模式配對充值先決失敗` | WARNING | 等待配對時充值先決失敗 | ph-ol-channel-cn* |
| `搶單提現建單請求失敗` | ERROR | infogen 建立提現單失敗 | ph-ol-channel-cn* |
| `搶單提現取消請求失敗` | ERROR | 提現取消請求失敗 | ph-ol-channel-cn* |
| `搶單提現確認到帳請求失敗` | ERROR | 確認到帳操作失敗 | ph-ol-channel-cn* |
| `極速提現單回流狀態異常` | ERROR | 提現單回流時狀態不對 | ph-ol-channel-cn* |
| `極速提現單逾時並重回配對池異常` | ERROR | 逾時後重回配對池失敗 | ph-ol-channel-cn* |
| `提現等待剩餘金額轉一般卡建單失敗` | ERROR | 剩餘金額轉一般卡失敗 | ph-ol-channel-cn* |

**排查步驟：**
1. 查 `極速提現配對失敗` → 確認是配對問題還是系統問題
2. 查 `提現通知資金池更新狀態發生錯誤` → 確認 paymentpool 通訊是否正常
3. 若提現卡住不動，查 `提現訂單已標記成功或失敗，中斷執行`

---

## 情境 3：銀行卡被鎖定

**觸發場景：** 卡片在充值或提現過程中被鎖定，導致配對失敗

**ELK 查詢關鍵字：**

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `微信配到的充值單已失敗, wechat_id=` | WARNING | 微信匹配到的充值單已失敗 | ph-ol-pool-cn* |
| `微信配到充值單，但所屬銀行卡已被鎖卡` | WARNING | 微信匹配後發現卡已鎖定 | ph-ol-pool-cn* |
| `簡訊配到的充值單已失敗, sms_id=` | WARNING | 簡訊匹配到的充值單已失敗 | ph-ol-pool-cn* |
| `簡訊配到充值單，但所屬銀行卡已被鎖卡` | WARNING | 簡訊匹配後發現卡已鎖定 | ph-ol-pool-cn* |
| `微信配到轉帳單，但所屬銀行卡已被鎖卡` | WARNING | 微信轉帳匹配後卡被鎖定 | ph-ol-pool-cn* |
| `簡訊配到轉帳單，但所屬銀行卡已被鎖卡` | WARNING | 簡訊轉帳匹配後卡被鎖定 | ph-ol-pool-cn* |
| `銀行卡 %s 沒等到餘額更新` | WARNING | 卡片餘額更新超時 | ph-ol-pool-cn* |

**排查步驟：**
1. 用卡號關鍵字（末 4 碼）搜尋該卡的所有 warning/error
2. 確認是何時被鎖、被鎖原因（超過次數上限 or 餘額異常）
3. 配合 `get_card_pool_status` 確認整體卡池健康狀態

---

## 情境 4：回調（Callback）失敗

**觸發場景：** 訂單完成但商戶端未收到通知，客戶反映「沒收到到帳通知」

**ELK 查詢關鍵字：**

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `發送充值結果通知給平台失敗` | INFO | 充值回調商戶失敗，含 http status | ph-ol-channel-cn* |
| `發送充值結果通知給平台成功` | INFO | 充值回調成功（確認有無此記錄） | ph-ol-channel-cn* |
| `充值通知狀態異常.*終止充值通知程序` | INFO | 狀態不對，跳過回調 | ph-ol-channel-cn* |
| `通知網址異常，終止充值通知程序` | INFO | 商戶回調 URL 有問題 | ph-ol-channel-cn* |
| `發送提現結果通知給平台失敗` | INFO | 提現回調商戶失敗 | ph-ol-channel-cn* |
| `發送提現結果通知給平台成功` | INFO | 提現回調成功（確認有無此記錄） | ph-ol-channel-cn* |
| `提現通知狀態異常.*終止提現通知程序` | INFO | 狀態不對，跳過回調 | ph-ol-channel-cn* |
| `notify recharge created failed` | WARNING | 充值建單通知失敗 | ph-ol-pool-cn* |
| `notification no paired invoice failed` | ERROR | 未配對發票通知失敗 | ph-ol-pool-cn* |
| `Notification failed` | ERROR | 通知任務失敗（需看 context 判斷是充值或提現） | ph-ol-pool-cn* |

**排查步驟：**
1. 用 order_no 搜尋 `發送充值結果通知給平台` → 查看是成功還是失敗
2. 若失敗，看 `http status` 欄位 → 5xx 是商戶端問題，connection refused 是網路問題
3. 若查不到通知記錄，查 `通知狀態異常` / `通知網址異常` → 回調可能被系統自行跳過

---

## 情境 5：風控拒絕 / 風控系統異常

**觸發場景：** 訂單被風控拒絕，或下單速度變慢

**ELK 查詢關鍵字：**

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `取得風控資料失敗` | ALERT | 風控查詢失敗（redis 或 risk_api 異常） | ph-ol-channel-cn* |
| `error message` | ERROR | risk_api 內部錯誤（看 context 判斷模組） | ph-ol-risk-api |
| `risk bankcard update failed` | WARNING | 風控銀行卡更新失敗 | ph-ol-pool-cn* |
| `risk bankcard insert failed` | WARNING | 風控銀行卡新增失敗 | ph-ol-pool-cn* |
| `risk record insert failed` | WARNING | 風控記錄寫入失敗 | ph-ol-pool-cn* |
| `connect to DB` | INFO | risk_api DB 連線（大量出現可能是頻繁重連） | ph-ol-risk-api |

**排查步驟：**
1. 查 `取得風控資料失敗` → 確認 risk_api 是否無法回應
2. 若 risk_api 本身有問題，查 `ph-ol-risk-api` index 的 ERROR
3. 若下單變慢但未失敗，可能是 risk_api 回應慢但未逾時（配合 `get_risk_status` 工具確認）

---

## 情境 6：SMS / 微信帳單配對失敗

**觸發場景：** 使用者已轉帳但系統未自動配對到充值單

**ELK 查詢關鍵字：**

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `嘗試配對微信與充值單` | INFO | 正在嘗試配對（確認是否有嘗試） | ph-ol-pool-cn* |
| `嘗試配對簡訊與充值單` | INFO | 正在嘗試配對（確認是否有嘗試） | ph-ol-pool-cn* |
| `微信配不到轉帳單` | WARNING | 微信轉帳找不到對應的充值單 | ph-ol-pool-cn* |
| `簡訊配不到轉帳單` | WARNING | 簡訊轉帳找不到對應的充值單 | ph-ol-pool-cn* |
| `[CAS-647] 配不到充值單` | INFO | 配對失敗的詳細記錄 | ph-ol-pool-cn* |

**排查步驟：**
1. 查 `嘗試配對微信與充值單` 或 `嘗試配對簡訊與充值單` → 確認有沒有收到帳單
2. 若有嘗試但失敗，查 `微信配不到轉帳單` → 可能是金額或時間不符
3. 若完全沒有嘗試記錄 → 可能是 SMS / WeChat 接收端未收到通知

---

## 情境 7：第三方連線異常

**觸發場景：** 與外部第三方支付通道或 Ginbao/Jinding 系統連線中斷

**ELK 查詢關鍵字：**

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `查單: %s 與第三方連線異常` | WARNING | 查詢第三方訂單時連線失敗 | ph-ol-pool-cn* |
| `查單: %s 發生 RequestException` | WARNING | 第三方查單發生 HTTP 請求異常 | ph-ol-pool-cn* |
| `查單: %s 發生非預期錯誤或異常` | WARNING | 第三方查單發生未知異常 | ph-ol-pool-cn* |
| `聊天室互動: %s 發生非預期錯誤或異常` | WARNING | 金寶聊天室互動異常 | ph-ol-pool-cn* |
| `(im) 接收 IM 訊息異常` | ERROR | IM 訊息接收失敗 | ph-ol-channel-cn* |
| `(tg) 接收 Telegram 訊息異常` | ERROR | Telegram 訊息接收失敗 | ph-ol-channel-cn* |
| `轉帳通知發送失敗` | ERROR | 轉帳通知發送至 IM 失敗 | ph-ol-channel-cn* |
| `充值通知發送失敗` | ERROR | 充值通知發送至 IM 失敗 | ph-ol-channel-cn* |
| `取得cashpool token發生例外錯誤(ginbao)` | ERROR | 取得 Ginbao token 失敗 | ph-ol-channel-cn* |

---

## 情境 8：圖片辨識 / OCR 問題

**觸發場景：** 使用者上傳收據但系統無法識別金額或帳號

**ELK 查詢關鍵字：**

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `圖片辨識發生錯誤, 轉AI辨識` | WARNING | 一般辨識失敗，改用 AI | ph-ol-channel-cn* |
| `ai 圖片ocr比對金額異常` | INFO | AI 辨識後金額不符 | ph-ol-channel-cn* |
| `ai 圖片ocr比對帳號異常` | INFO | AI 辨識後帳號不符 | ph-ol-channel-cn* |
| `ai 圖片ocr比對收款名異常` | INFO | AI 辨識後收款人不符 | ph-ol-channel-cn* |
| `ai 圖片ocr比對付款名異常` | INFO | AI 辨識後付款人不符 | ph-ol-channel-cn* |
| `充值通知讀取用戶上傳憑證圖片失敗` | ERROR | 無法讀取使用者上傳的憑證圖片 | ph-ol-channel-cn* |
| `open ai validation error` | ERROR | OpenAI 驗證失敗 | ph-ol-channel-cn* |
| `ai查詢銀行失敗` | INFO | AI 銀行查詢失敗 | ph-ol-channel-cn* |

---

## 情境 9：前端（infogen）問題

**觸發場景：** 使用者反映充值/提現頁面異常，或操作後無反應

**ELK 查詢關鍵字：**

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `搶單充值建單請求失敗, userid=` | ERROR | 前端建立充值單失敗，含 user ID | ph-ol-channel-cn* |
| `搶單提現建單請求失敗, code=` | ERROR | 前端建立提現單失敗 | ph-ol-channel-cn* |
| `極速提現頁面請求失敗` | ERROR | 前端請求提現頁面失敗 | ph-ol-channel-cn* |
| `前端充值%s紀錄` | WARNING | 前端充值操作異常紀錄 | ph-ol-channel-cn* |
| `前端提現%s紀錄` | WARNING | 前端提現操作異常紀錄 | ph-ol-channel-cn* |
| `[ProcessRechargeUpdate Job: Cache Data Expired]` | INFO | 充值狀態快取過期（使用者長時間停留頁面） | ph-ol-channel-cn* |
| `[ProcessWithdrawUpdate Job: Cache Data Expired]` | INFO | 提現狀態快取過期 | ph-ol-channel-cn* |

---

## 情境 10：業務自動化指標（AI GB）

**觸發場景：** 查詢自動化比例、上卡/下卡/回款 USDT 次數

**ELK 關鍵字（直接搜尋 message 欄位）：**

| 關鍵字 | 意義 | Index |
|--------|------|-------|
| `GetGbMchParams` | 呼叫 AI 取得商戶參數（AI 次數） | ph-ol-channel-cn* |
| `DepositChange` | 回款 USDT 事件 | ph-ol-channel-cn* |
| `BankcardAlter` | 支付寶/微信下卡（解除綁定） | ph-ol-channel-cn* |
| `JfbWiReg` | 支付寶/微信上卡（新增綁定） | ph-ol-channel-cn* |

> 這四個關鍵字對應到 payment service 的 `app/Domains/Ai/Actions/` 目錄下的 Action class 名稱，
> 寫入 log 時以 class 名稱作為關鍵字出現在 message 中。

---

## 情境 11：匯率拉取失敗

**觸發場景：** payment-flow 無法取得最新匯率（影響 USDT/CNY 換算）

**ELK 查詢關鍵字：**

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `火幣拉取資料失敗` | ERROR | 火幣交易所 API 無法取得匯率 | ph-ol-channel-cn* |
| `歐易拉取資料失敗` | ERROR | OKEx 交易所 API 無法取得匯率 | ph-ol-channel-cn* |
| `幣安拉取資料失敗` | ERROR | Binance API 無法取得匯率 | ph-ol-channel-cn* |

---

## 情境 12：金寶 SSR 連線問題

**觸發場景：** Ginbao（金寶）的 SSR 連線異常或過期

**ELK 查詢關鍵字：**

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `金寶 SSR 連線存活檢查(連線已過期)` | INFO | SSR 連線已過期，需重連 | ph-ol-pool-cn* |
| `金寶 SSR 連線存活檢查(資料異常)` | INFO | SSR 連線資料異常 | ph-ol-pool-cn* |
| `金寶 SSR 連線存活檢查(連線尚未過期)` | INFO | SSR 連線正常（用來確認是否有定期檢查） | ph-ol-pool-cn* |

---

## 情境 13：餘額池（拆單）配對操作

**觸發場景：** 執行 Workflow 2B（拆單配對）時，查詢餘額池狀態或確認配對結果

**ELK 查詢關鍵字：**

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `極速充值配對提現等待` | INFO | 充值單正在嘗試配對餘額池提現單 | ph-ol-pool-cn* |
| `極速充值建立配對訂單` | INFO | 充值單成功配對到子提現單（含 recharge_id、transfer_id） | ph-ol-pool-cn* |
| `極速充值配對提現等待剩餘金額失敗` | INFO | 配對失敗（無法 lock） | ph-ol-pool-cn* |
| `極速充值配對提現等待剩餘金額失敗(已達上限次數、金額)` | INFO | 配對失敗（超過 maxWithdrawCount、金額超出或重複） | ph-ol-pool-cn* |
| `餘額池商戶建單失敗` | INFO | 配對成功但商戶建子提現單失敗 | ph-ol-pool-cn* |

**查詢方式：**
- 查特定提現單的餘額池狀態：`{orderNo}` in `{env}-pool-cn`
- 確認充值單配對結果：`極速充值建立配對訂單` + `{PAY訂單號}` in `{env}-pool-cn`
- ⚠️ 查 `remaining_balance` / `pool_withdraw_balances` 狀態：用 `{env}-channel-cn*`（不是 pool-cn），詳見 `pm-ops-spec.md` Workflow 2B Step 2.2

---

## 情境 14：充值二階段查詢

**觸發場景：** 充值單進入第二階段驗證（明細/SMS/微信對帳），查詢是否配對成功或逾時

**ELK 查詢關鍵字：**

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `充值二階段查詢, id=` | INFO | 開始二階段查詢 | ph-ol-pool-cn* |
| `充值二階段查詢逾時, id=` | INFO | 二階段逾時，訂單已過期 | ph-ol-pool-cn* |
| `充值二階段查詢失敗,未過期跳過處理, id=` | INFO | 查詢失敗但尚未過期，跳過處理 | ph-ol-pool-cn* |
| `充值二階段明細比對成功, id=` | INFO | 明細對帳配對成功 | ph-ol-pool-cn* |
| `充值二階段短信比對成功, id=` | INFO | SMS 對帳配對成功 | ph-ol-pool-cn* |
| `充值二階段微信短信比對成功, id=` | INFO | 微信 SMS 對帳配對成功 | ph-ol-pool-cn* |
| `明細配對通知資金池失敗, id=` | INFO | 明細配對成功但通知 pool 失敗 | ph-ol-pool-cn* |

**排查步驟：**
1. 查 `充值二階段查詢` + 訂單號 → 確認是否進入二階段
2. 查 `充值二階段查詢逾時` → 訂單過期，需手動確認
3. 查 `明細配對通知資金池失敗` → 配對成功但 pool 未同步，可能需要手動觸發回調

---

## 情境 15：退款 / 沖正

**觸發場景：** 提現失敗需退款，或銀行產生沖正（reversal）交易

**ELK 查詢關鍵字：**

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `退款列入等待隊列, order id=` | INFO | 退款單進入等待佇列 | ph-ol-pool-cn* |
| `開始資金池退款查詢, order id=` | INFO | 資金池退款查詢開始 | ph-ol-pool-cn* |
| `資金池退款查詢失敗, order id=` | INFO | 退款查詢失敗 | ph-ol-pool-cn* |
| `資金池退款查詢結果, res=` | INFO | 退款查詢結果（看 res 判斷狀態） | ph-ol-pool-cn* |
| `退款單狀態取消，等待確認, payment_id=` | INFO | 退款單狀態取消，待人工確認 | ph-ol-pool-cn* |
| `退款單提現失敗，等待重試, payment_id=` | INFO | 退款提現失敗，進入重試 | ph-ol-pool-cn* |
| `退款訂單已標記成功或失敗，中斷執行, order=` | INFO | 退款單已有終態，停止重複執行 | ph-ol-pool-cn* |
| `退款訂單進入重試階段，停止查詢, order=` | INFO | 退款進入重試，停止主查詢 | ph-ol-pool-cn* |
| `退款單更新發生異常錯誤, order id=` | INFO | 退款單更新時發生異常 | ph-ol-pool-cn* |
| `查無退款單, payment_id=` | INFO | 收到退款通知但找不到退款單 | ph-ol-pool-cn* |
| `RECORD_ID: ... 為沖正` | INFO | 交易紀錄被標記為沖正 | ph-ol-pool-cn* |
| `簡訊配不到沖正單` | WARNING | SMS 無法配對到沖正訂單 | ph-ol-pool-cn* |
| `簡訊配到沖正單，但所屬銀行卡已被鎖卡` | WARNING | SMS 配到沖正但卡已鎖定 | ph-ol-pool-cn* |
| `微信配不到沖正單` | WARNING | 微信無法配對到沖正訂單 | ph-ol-pool-cn* |
| `微信配到沖正單，但所屬銀行卡已被鎖卡` | WARNING | 微信配到沖正但卡已鎖定 | ph-ol-pool-cn* |

**排查步驟：**
1. 查 `退款列入等待隊列` / `開始資金池退款查詢` → 確認退款流程是否啟動
2. 查 `資金池退款查詢失敗` → 若持續失敗，確認 paymentpool 服務狀態
3. 查 `沖正` 相關 → 確認是否為銀行沖正導致餘額異常

---

## 情境 16：提現重試機制

**觸發場景：** 提現或退款進入重試流程，查詢重試狀態

**ELK 查詢關鍵字：**

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `重試提現單重新查詢開始, order id=` | INFO | 提現重試查詢開始 | ph-ol-pool-cn* |
| `重試提現單已列入黑名單, order id=` | INFO | 提現單被加入黑名單，不再重試 | ph-ol-pool-cn* |
| `重試提現單逾時, order id=` | INFO | 提現重試逾時 | ph-ol-pool-cn* |
| `提現訂單已標記成功或失敗，中斷執行, order=` | INFO | 提現單已有終態，停止重複執行 | ph-ol-pool-cn* |
| `資金池通知提現結果因審核中終止流程, order=` | WARNING | 提現審核中，pool 通知被跳過 | ph-ol-pool-cn* |
| `資金池通知轉帳單數量異常, payment_id=` | INFO | Pool 通知時轉帳單數量不符（餘額池常見） | ph-ol-pool-cn* |
| `提現單狀態取消，等待確認, payment_id=` | INFO | 提現取消，等待人工確認 | ph-ol-pool-cn* |
| `非搶單類型無法處理此狀態資金池提現通知, payment_id=` | INFO | 非搶單提現收到 pool 通知，無法處理 | ph-ol-pool-cn* |
| `開始資金池提現查詢, order id=` | INFO | 資金池提現查詢開始（正常流程） | ph-ol-pool-cn* |
| `資金池提現查詢失敗, order id=` | INFO | 提現查詢失敗（看 res 確認原因） | ph-ol-pool-cn* |

**排查步驟：**
1. 查 `重試提現單重新查詢開始` → 確認重試次數（retry 欄位）
2. 查 `重試提現單已列入黑名單` → 被黑名單代表需人工介入
3. 查 `資金池通知提現結果因審核中終止流程` → 確認是否卡在審核狀態

---

## 情境 17：餘額池管理操作

**觸發場景：** 人工操作餘額池（拆單、刪除、設優先配對等）

**ELK 查詢關鍵字：**

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `餘額池人工刪除, id=` | INFO | 人工刪除餘額池訂單 | ph-ol-pool-cn* |
| `解鎖報錯訂單, id=` | INFO | 解鎖異常訂單 | ph-ol-pool-cn* |
| `剩餘池訂單優先配對設定, id=` | INFO | 設定單筆優先配對 | ph-ol-pool-cn* |
| `剩餘池訂單優先配對批量設定, id=` | INFO | 批量設定優先配對 | ph-ol-pool-cn* |
| `餘額池商戶建單失敗, id=` | INFO | 餘額池配對成功但商戶建子單失敗 | ph-ol-pool-cn* |
| `餘額池商戶建單失敗更新, id=` | WARNING | 餘額池失敗資訊更新 | ph-ol-pool-cn* |
| `充值金額鎖推進多個 delay job` | INFO | 充值金額鎖啟動多個延遲任務 | ph-ol-pool-cn* |

**排查步驟：**
- 查 `餘額池商戶建單失敗` + 提現單號 → 確認哪次配對失敗及原因
- 查 `解鎖報錯訂單` → 確認人工解鎖操作是否執行

---

## 情境 18：銀行卡管理（變更 / 解鎖）

**觸發場景：** 卡片被換卡、解鎖，或卡片管理通知

**ELK 查詢關鍵字：**

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `變更銀行卡成功, merchants_order=` | INFO | 換卡操作成功 | ph-ol-payment-cn |
| `變更銀行卡失敗, merchants_order=` | INFO | 換卡操作失敗（含錯誤訊息） | ph-ol-payment-cn |
| `變更銀行卡qrcode, merchants_order=` | INFO | 換卡後更新 QR Code | ph-ol-payment-cn |
| `用戶一般卡充值取消換卡, order=` | INFO | 使用者取消充值並換卡 | ph-ol-channel-cn* |
| `接收中間站取消重試充值單失敗, order=` | ERROR | 取消重試充值單失敗 | ph-ol-channel-cn* |
| `通知資金池新增銀行卡資料, params=` | INFO | 通知 pool 新增銀行卡 | ph-ol-pool-cn* |
| `通知資金池更新銀行卡資料, params=` | INFO | 通知 pool 更新銀行卡資料 | ph-ol-pool-cn* |

---

## 情境 19：Ginbao（金寶）/ 資金池通知

**觸發場景：** payment-flow 收到 Ginbao 任務通知、催促、取消，或通知發送失敗

**ELK 查詢關鍵字：**

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `接收資金池金寶用戶新任務通知, params=` | INFO | 收到新任務通知 | ph-ol-channel-cn* |
| `接收資金池金寶用戶催促通知, params=` | INFO | 收到催促通知 | ph-ol-channel-cn* |
| `接收資金池金寶用戶取消通知, params=` | INFO | 收到取消通知 | ph-ol-channel-cn* |
| `接收資金池金寶用戶充值催促通知, params=` | INFO | 收到充值催促通知 | ph-ol-channel-cn* |
| `找不到商戶` | WARNING | 通知路由時找不到對應商戶 | ph-ol-channel-cn* |
| `通知 Payment 充值完成成功` | INFO | 充值完成通知 Payment 成功 | ph-ol-pool-cn* |
| `通知 Payment 充值完成意外錯誤` | ERROR | 充值完成通知 Payment 失敗 | ph-ol-pool-cn* |
| `通知 Flow 充值完成成功` | INFO | 充值完成通知 payment-flow 成功 | ph-ol-pool-cn* |
| `通知 Flow 充值完成失敗` | WARNING | 充值完成通知 payment-flow 失敗 | ph-ol-pool-cn* |
| `轉帳通知讀取二維碼圖片失敗` | ERROR | 提現通知時無法讀取 QR Code 圖片 | ph-ol-channel-cn* |

**排查步驟：**
1. 查 `接收資金池金寶用戶新任務通知` → 確認 Ginbao 任務是否送達
2. 查 `找不到商戶` → 確認商戶設定是否正常
3. 查 `通知 Payment 充值完成意外錯誤` → 確認 payment-flow ↔ payment 通訊是否異常

---

## 情境 20：極速直連操作記錄（Direct API）

**觸發場景：** 透過 Direct API 發起充值/提現，或直連相關操作記錄

**ELK 查詢關鍵字：**

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `極速直連充值申請, params=` | INFO | Direct API 充值建單 | ph-ol-channel-cn* |
| `極速直連充值取消等待申請, params=` | INFO | Direct API 充值取消（等待中） | ph-ol-channel-cn* |
| `極速直連充值查核中取消申請, params=` | INFO | Direct API 充值取消（查核中） | ph-ol-channel-cn* |
| `極速直連充值回單辨識申請, id=` | INFO | Direct API 充值憑證 OCR | ph-ol-channel-cn* |
| `極速提現直連申請, memberid=` | INFO | Direct API 提現建單 | ph-ol-channel-cn* |
| `極速提現直連用戶確認到帳, order=` | INFO | Direct API 使用者確認到帳 | ph-ol-channel-cn* |
| `極速提現強制失敗查無轉帳單, id=` | WARNING | 強制失敗時找不到轉帳單 | ph-ol-channel-cn* |
| `極速提現強制失敗, id=` | WARNING | 極速提現被強制標記失敗 | ph-ol-channel-cn* |
| `withdraw qrcode_detect_decode 502 error` | INFO | 二維碼識別服務 502 超時 | ph-ol-channel-cn* |

**排查步驟：**
- 查 `極速直連充值申請` / `極速提現直連申請` → 確認 Direct API 是否成功收單
- 查 `極速提現強制失敗` → 確認是人工還是系統觸發的強制失敗

---

## 情境 21：人工補單

**觸發場景：** PM 人工補單（充值或提現），查詢操作記錄

**ELK 查詢關鍵字：**

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `人工充值補單審核發生錯誤` | ERROR | 人工充值補單審核時出錯 | ph-ol-payment-cn |
| `人工` + 充值單號 | INFO | 人工補單操作記錄 | ph-ol-payment-cn |

> 人工補單記錄由 `RechargeLogger` / `WithdrawLogger` 寫入，message 含「人工」字樣。

---

## 情境 22：Queue 異常 / 處理延遲

**觸發場景：** 懷疑 Job 堆積、Queue Worker 異常、API 回應過慢

**ELK 查詢關鍵字（pool-cn*）：**

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `[Queue Job]` + `failed` | WARNING | Queue Job 執行失敗 | `{env}-pool-cn` |
| `[Queue Job]` + `released` | WARNING | Job 被釋放回佇列（重試中） | `{env}-pool-cn` |
| `Request Lifecycle Is longer than 10000 ms` | WARNING | 單次 API 請求超過 10 秒 | `{env}-pool-cn` |

**Queue Job log 欄位說明：**
- `queue`：佇列名稱（如 `default`、`amountlock`）
- `job`：Job class 名稱（如 `AmountLockOverdueJob`）
- `status_name`：`starting` / `success` / `failed` / `released`
- `attempts`：已重試次數
- `duration`：執行時長（秒）
- `exception_message`：失敗時的錯誤訊息

**排查步驟：**
1. 查 `[Queue Job]` + `failed` → 確認哪個 Job class 失敗、失敗原因（exception_message）
2. 若 attempts 持續增加 → Job 在重試循環，查 `released` 確認
3. 查 `Request Lifecycle Is longer than 10000 ms` → 確認哪個 URL 過慢，對照 `url` 欄位

> ⚠️ Queue Job 日誌只在 pool-cn*（paymentpool service）。若是 channel service 的慢請求，查 channel-cn*。

---

## 情境 23：卡池全鎖 / 無可用卡

**觸發場景：** 充值或提現一直無法取到卡、「下單一直轉圈」、卡池可用數量為零

**ELK 查詢關鍵字（pool-cn*）：**

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `AtomicLockAllUsableCards` | WARNING | 充值取卡時，可用卡全部被金額鎖住（暫時性） | `{env}-pool-cn` |
| `AtomicLockCardAmount` | WARNING | 特定卡+金額組合被鎖，該卡跳過 | `{env}-pool-cn` |
| `ChannelHasNoCardToUse` | WARNING | 渠道完全沒有可用卡片（需人工上卡） | `{env}-pool-cn` |
| `BankcardHeartStop` | WARNING | 銀行卡心跳停止（客端失聯） | `{env}-pool-cn` |
| `BankcardBalanceNotUpToDate` | WARNING | 銀行卡餘額過久未更新（>閾值） | `{env}-pool-cn` |
| `ThirdPartyFilter 過濾後無可用卡片` | INFO | 取卡流程最終結果：無卡可用 | `{env}-pool-cn` |
| `鎖卡 (BankcardAbnormalListener` | INFO | 有卡被鎖定，含卡號和鎖定原因 | `{env}-pool-cn` |

**卡異常類型（ErrorTypeEnum）常見值：**
| enum name | 意義 |
|-----------|------|
| `BankcardHeartStop` | 心跳停止 |
| `BankcardBalanceNotUpToDate` | 餘額未更新 |
| `BankcardAbnormalBalance` | 異常餘額 |
| `BankcardAbnormalTransferFailOverTimes` | 轉出失敗次數超限 |
| `AtomicLockAllUsableCards` | 可用卡全鎖 |
| `ChannelHasNoCardToUse` | 渠道無可用卡 |
| `UsableCardsAreAllFailedBefore` | 重試時先前失敗卡全被過濾 |
| `RechargeWaitQRCodeLogin` | 待 QRCode 登入（充值） |
| `WithdrawWaitQRCodeLogin` | 待 QRCode 登入（提現） |

**排查步驟：**
1. 先查 `ThirdPartyFilter 過濾後無可用卡片`（情境 1 已有）→ 確認是否真的無卡
2. 查 `ChannelHasNoCardToUse` → 若有，渠道確實無卡，需人工處理
3. 查 `AtomicLockAllUsableCards` → 若有，卡在金額鎖，等鎖釋放或擴卡
4. 查 `BankcardHeartStop` / `BankcardBalanceNotUpToDate` → 找出失聯的卡，交硬體或 App 側確認
5. 查 `鎖卡` → 找出被鎖卡號，確認 error 欄位中的 enum name 判斷原因

> ⚠️ 若整個渠道大量鎖卡（BankcardHeartStop 批量），通常是客端 App crash 或網路中斷，非系統問題。

---

## 情境 24：充值頁面無顯示 / 空白頁

**觸發場景：** 用戶反映充值頁面無銀行卡資訊、空白、無顯示。訂單已建成（有 PAY 單號）但前端看不到卡片資訊。

**根因通常是取卡延遲或失敗**，需追蹤配卡流程和 WebSocket 推送時序。

**ELK 查詢關鍵字（channel-cn*）：**

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `極速充值是否允許配卡` | 200 | 初次配卡判斷（看「是」或「否」）| `{env}-channel-cn*` |
| `充值任務派發` | 200 | 訂單排入延遲配卡任務（看 status 和 delay 時間） | `{env}-channel-cn*` |
| `執行嘗試配卡任務` | 200 | 延遲配卡任務開始執行 | `{env}-channel-cn*` |
| `極速充值自動配卡成功` | 200 | 配卡成功（含 payment_id）| `{env}-channel-cn*` |
| `極速充值等待配對配卡` | 200 | 訂單進入 WAIT_AUTO_PAIR(14) 等待自動配卡 | `{env}-channel-cn*` |
| `取銀行卡結果` | 200 | 配卡結果（含 bank_card_id、金額）| `{env}-channel-cn*` |
| `streamer emit` | 200 | WebSocket 推送至前端（看 status 和是否帶卡片資訊）| `{env}-channel-cn*` |

**排查步驟：**
1. 查 `極速充值是否允許配卡` + 訂單號 → 初次配卡結果
   - `=是` → 正常配卡，問題可能在前端渲染
   - `=否` → 初次配卡被拒，訂單進入 WAIT_AUTO_PAIR(14)
2. 若 `=否`，查 `充值任務派發` → 確認延遲任務排程時間
3. 查 `執行嘗試配卡任務` → 確認重試是否執行
4. 查 `極速充值自動配卡成功` → 重試是否成功
5. 查 `streamer emit` + 訂單號 → 比對 WebSocket 推送時序：
   - 第一次推送（無卡資訊，status=5）→ 前端此時顯示空白
   - 第二次推送（有卡資訊）→ 前端應更新顯示
   - 若只有第一次沒第二次 → 配卡確實失敗
   - 若兩次都有 → 前端未正確處理第二次推送（WebSocket 連線問題或前端 bug）

---

## 快速排查對照表

| 使用者反映 | 優先查詢的 ELK 關鍵字 |
|-----------|---------------------|
| 「充值了但沒到帳」 | pool-cn*: `充值單: %s 領單失敗` → `ThirdPartyFilter 過濾後無可用卡片` |
| 「提現一直沒收到」 | channel-cn*: `極速提現配對失敗` → `發送提現結果通知給平台失敗` |
| 「客戶說沒收到回調通知」 | channel-cn*: `發送充值/提現結果通知給平台失敗` + 看 http status（5xx=對方問題） |
| 「下單一直轉圈」 | channel-cn*: `取得風控資料失敗` → pool-cn*: `ThirdPartyFilter 過濾後無可用卡片` → pool-cn*: `ChannelHasNoCardToUse` |
| 「卡都被鎖了/沒卡可用」 | pool-cn*: `ChannelHasNoCardToUse` OR `AtomicLockAllUsableCards` OR `BankcardHeartStop` |
| 「上傳截圖但過了很久」 | channel-cn*: `圖片辨識發生錯誤` → `ai 圖片ocr比對` 系列 |
| 「一直顯示配對中」 | pool-cn*: `嘗試配對微信與充值單` → `微信配不到轉帳單` |
| 「是否是我方問題」 | channel-cn*: 查 `發送通知給平台失敗` 的 http status，5xx=對方問題 |
| 「充值卡在二階段」 | pool-cn*: `充值二階段查詢` → `充值二階段查詢逾時` |
| 「API 速度很慢/超時」 | pool-cn*: `Request Lifecycle Is longer than 10000 ms`，看 url 欄位 |
| 「Job 一直失敗/Queue 卡住」 | pool-cn*: `[Queue Job]` + `failed`，看 job 和 exception_message 欄位 |
| 「提現退款沒到帳」 | pool-cn*: `退款列入等待隊列` → `資金池退款查詢失敗` → `退款單提現失敗，等待重試` |
| 「提現重試很多次了」 | pool-cn*: `重試提現單重新查詢開始`（看 retry 次數）→ `重試提現單已列入黑名單` |
| 「餘額池一直建單失敗」 | pool-cn*: `餘額池商戶建單失敗` + 提現單號 |
| 「換卡後充值進不來」 | payment-cn: `變更銀行卡失敗` / `變更銀行卡qrcode` |
| 「銀行沖正/退款異常」 | pool-cn*: `RECORD_ID: ... 為沖正` → `簡訊/微信配不到沖正單` |
| 「Ginbao 沒收到任務」 | channel-cn*: `接收資金池金寶用戶新任務通知` → `找不到商戶` |
| 「Direct API 訂單沒建成」 | channel-cn*: `極速直連充值申請` / `極速提現直連申請` |
| 「充值頁面無顯示/空白」 | channel-cn*: `極速充值是否允許配卡` → `充值任務派發` → `極速充值自動配卡成功` → `streamer emit`（看時序） |

---

## 標準查詢條件

所有 ELK 查詢預設使用以下條件（除非需求中有明確指示）：

**時間範圍：**
- 預設：近 24 小時（`gte: now-24h`）
- 若需求中明確提及特定日期（如「3/19 的 log」）：改查當天 00:00–23:59
- 若 24 小時查不到結果：再擴展至 7 天

**結果數量（依查詢類型）：**
- 有訂單號 / 識別符查詢：`size: 200`（訂單 log 通常 < 200 筆，全拿以免漏失關鍵事件）
- 純關鍵字查詢（無識別符）：`size: 50`（系統級查詢可命中數千筆，需限制）

**排除條件（must_not）：**

以下為高頻零診斷價值 log，預設加入 must_not，對所有查詢生效：

| 排除模式 | 類型 | 說明 | 每日頻率 |
|---------|------|------|---------|
| `*用了 * 秒*` | wildcard | JobTimer 執行時間記錄（13+ 個定時任務） | >900/hr |
| `*充值單金額鎖推進多個 delay job*` | wildcard | AmountLockJob 派發記錄 | ~1440 |
| `*開始檢查各平台未配對充值明細*` | wildcard | Cron 開始 marker | ~1440 |
| `*檢查各平台未配對充值明細結束*` | wildcard | Cron 結束 marker | ~1440 |
| `*開始搜尋未充值的小數點充值模式訂單*` | wildcard | Cron 開始 marker | ~1440 |
| `*開始定時刪除一個禮拜前的匯出紀錄*` | wildcard | Cron 開始 marker | ~1440 |
| `*金寶 SSR 連線存活檢查*` | wildcard | Ginbao heartbeat（3 種狀態都記錄） | 高頻 |
| `Listeners\Reverb\EventSent` | match_phrase | WebSocket broadcast log，每次事件推送都記錄，單筆 5KB | 高頻 |

> ⚠️ SMS / 微信配對 log（`嘗試配對簡訊與充值單`、`配不到充值單` 等）**不排除**，查 SMS 配對問題（情境 6）時需要。

**標準 DSL 片段：**

```json
"sort": [{"datetime": {"order": "asc", "unmapped_type": "date"}}],
"must_not": [
  {"wildcard": {"message": "*用了 * 秒*"}},
  {"wildcard": {"message": "*充值單金額鎖推進多個 delay job*"}},
  {"wildcard": {"message": "*開始檢查各平台未配對充值明細*"}},
  {"wildcard": {"message": "*檢查各平台未配對充值明細結束*"}},
  {"wildcard": {"message": "*開始搜尋未充值的小數點充值模式訂單*"}},
  {"wildcard": {"message": "*開始定時刪除一個禮拜前的匯出紀錄*"}},
  {"wildcard": {"message": "*金寶 SSR 連線存活檢查*"}},
  {"match_phrase": {"message": "Listeners\\Reverb\\EventSent"}}
]
```

> `unmapped_type: "date"` 確保跨 index 查詢時，沒有 `datetime` 欄位的 index（如 `risk-api`）不會報錯，該筆 log 排序到最後。
> 查 `risk-api` 專用查詢時改用 `@timestamp` 排序。

---

## 給 AI Agent 的查詢指引

```
收到「充值失敗」類問題：
  → 優先查 ph-ol-pool-cn*，keyword: "ThirdPartyFilter 過濾後無可用卡片" OR "領單失敗"
  → 再查 ph-ol-channel-cn*，keyword: "搶單充值建單請求失敗"

收到「充值卡在二階段」：
  → 查 ph-ol-pool-cn*，keyword: "充值二階段查詢" + 訂單號
  → 若逾時：查 "充值二階段查詢逾時"
  → 若通知失敗：查 "明細配對通知資金池失敗"

收到「提現沒收到」類問題：
  → 查 ph-ol-channel-cn*，keyword: "發送提現結果通知給平台"
  → 若有失敗記錄，看 http status 判斷是我方還是客戶端問題
  → 若提現重試多次：查 "重試提現單重新查詢開始" 確認 retry 次數

收到「退款/沖正」問題：
  → 查 ph-ol-pool-cn*，keyword: "退款列入等待隊列" OR "資金池退款查詢"
  → 沖正問題：查 "為沖正" OR "配不到沖正單"

收到「回調沒收到」類問題：
  → 查 ph-ol-channel-cn*，keyword: order_no + "通知給平台"
  → 確認是成功還是失敗，若失敗看狀態碼

收到「系統速度慢」問題：
  → 查 ph-ol-channel-cn*，keyword: "取得風控資料失敗"
  → 查 ph-ol-pool-cn*，keyword: "ThirdPartyFilter 過濾後無可用卡片"
  → 查 ph-ol-pool-cn*，keyword: "Request Lifecycle Is longer than 10000 ms"（有的話看 url 欄位定位慢 API）

收到「沒有卡可用」/ 「下單失敗卡池空了」問題：
  → 查 ph-ol-pool-cn*，keyword: "ChannelHasNoCardToUse"（渠道無卡，需人工處理）
  → 查 ph-ol-pool-cn*，keyword: "AtomicLockAllUsableCards"（卡被金額鎖，等鎖釋放）
  → 查 ph-ol-pool-cn*，keyword: "BankcardHeartStop"（客端失聯，交 App 側確認）
  → 最終確認：查 "ThirdPartyFilter 過濾後無可用卡片"

收到「Job 失敗」/ 「Queue 堆積」問題：
  → 查 ph-ol-pool-cn*，keyword: "[Queue Job]" + "failed"
  → 看 job 欄位（哪個 Job class）和 exception_message（失敗原因）
  → 若 attempts 持續增加 → 查 "released" 確認是否重試循環

查詢餘額池/拆單問題：
  → 查 ph-ol-pool-cn*，keyword: "餘額池商戶建單失敗" OR "剩餘池訂單優先配對"
  → 人工操作記錄：查 "餘額池人工刪除" OR "解鎖報錯訂單"

查詢 Ginbao 任務通知：
  → 查 ph-ol-channel-cn*，keyword: "接收資金池金寶用戶" 系列
  → 若找不到商戶：查 "找不到商戶"

查詢 Direct API 操作記錄：
  → 查 ph-ol-channel-cn*，keyword: "極速直連充值申請" OR "極速提現直連申請"

查詢業務自動化指標：
  → 查 ph-ol-channel-cn*，keyword: "GetGbMchParams" OR "DepositChange" OR "BankcardAlter" OR "JfbWiReg"

注意：關鍵字皆為中文，ELK query_string 查詢時直接輸入中文即可。
時區統一使用 +08:00。

訂單查詢策略：單一關鍵字有時無法命中所有相關 log。
建議同時帶入以下多個識別符做 OR 查詢，覆蓋完整鏈路：
  - userid（使用者 ID）
  - 流水號（request_id）
  - PAY 訂單號（PAY...）
  - 商戶訂單號（merchants_order）

ELK query 範例：
  "PAY20240101001" OR "12345678" OR "user-abc" OR "MO-20240101-001"
```
