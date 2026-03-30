# OnePay AI PM 操作規格文檔

> 版本：v1.0（2026-03-06）
> 範疇：項目對接群中 AI PM 的三項核心工作流程
> 備注：Payment MCP 接口規格待 RD 實作後併入，目前以 [PENDING] 標示

## 機密設定

各平台的 `memberid`（平台代碼）與 `secret_key`（簽名金鑰）存放於：

```
~/.openclaw/workspace/secrets/onepay-platforms.json
```

格式（key = memberid，不是 platform code）：
```json
{
  "JSTEST06": {
    "name": "平台名稱",
    "memberid": "JSTEST06",
    "secret_key": "..."
  },
  "JSIANTEST01": {
    "name": "平台名稱",
    "memberid": "JSIANTEST01",
    "secret_key": "..."
  }
}
```

> 執行 Workflow 2 建充值單時，用 ELK 查得的 `wdr_memberid` 作為 key 查找 `secret_key` 來組 sign：
> `platforms[wdr_memberid]["secret_key"]`

## 環境域名

| 環境 | Payment API | Infogen |
|------|-------------|---------|
| pre  | `https://pre.channel.1-pay.co` | `https://pre-infogen.1-pay.co` |
| 正式（ol） | `https://channel.1-pay.co` | 待補充 |

Direct API 完整路徑：`{Payment API}/api/auction/direct/recharge/create`

測試用 notifyurl：`{Payment API}/api/test/auction/recharge/fake/notifyurl`
測試用 infourl：`{Payment API}/api/test/auction/recharge/fake/infourl`

---

## 系統架構概覽

### 服務地圖

```
[使用者]
   │
   ▼
infogen-micro-service   ← 極速收/提款前端入口（Vue 3 + Laravel）
   │ HTTP + AES
   ▼
payment                 ← 訂單中心（充提款訂單生命週期）
   │            │
   │ OAuth      │ PAYFLOW_HOST
   ▼            ▼
paymentpool    payment-flow    ← 卡池管理 / 支付通道路由
   │            │
   └─────┬──────┘
         │ HTTP
         ▼
      risk_api            ← 風控系統（Flask + ML）
```

### 各服務職責

| 服務 | 職責 | 異常時影響 |
|------|------|-----------|
| **infogen** | 使用者前端入口、WebSocket 推送、截圖上傳 | 使用者看到頁面異常 |
| **payment** | 訂單生命週期、商戶整合、Horizon 隊列 | 訂單無法建立或卡住 |
| **paymentpool** | 銀行卡池管理、Auction 競拍選卡 | 可用卡歸零 = 所有充值停擺（最高告警） |
| **payment-flow** | 第三方通道路由、多地區匯率 | 提現無法出款 |
| **risk_api** | 風控評估（同步阻塞） | 回應慢 → 所有下單速度下降 |

### 極速（Auction）主流程

**充值：**
```
建單(infogen→payment) → 風控(risk_api) → 競拍選卡(paymentpool)
→ 使用者轉帳上傳收據 → 確認到帳 → WebSocket 推播完成
```

**提現：**
```
建單(infogen→payment) → 風控(risk_api) → 選付款卡(paymentpool)
→ 路由出款(payment-flow) → WebSocket 推播結果
```

**關鍵阻塞點：** 風控（Step 2）和選卡（Step 3）為同步串行，任一超時直接影響使用者體感。

### 根因快速排查

| 現象 | 優先排查方向 |
|------|-------------|
| 充值訂單無法建立 | paymentpool 可用卡數量 → risk_api 狀態 |
| 提款訂單卡住 | payment-flow 通道 → risk_api 狀態 |
| 前端狀態不更新 | WebSocket（Reverb / Echo Server） |
| 訂單建立慢（>3s） | risk_api 回應時間 → Redis 連線 |
| 大量訂單停在「處理中」 | Horizon Queue 積壓 → payment-flow 回調 |
| 截圖上傳失敗 | 七牛雲服務狀態 |

---

## 核心工作流程總覽

| # | 工作流程 | 觸發情境 | 狀態 |
|---|----------|----------|------|
| 1 | **訂單回調成功/失敗** | 客戶在測試群反映未收到回調，或要求手動觸發成功/失敗 | 待 RD 實作 Payment MCP |
| 2 | **充值建單配對提現** | 項目測試群發出提現單，需由我方建充值單進行配對測試 | 直接呼叫 Direct API，不需額外 MCP |
| 3 | **查詢訂單狀態** | 客戶提供訂單號，查詢訂單目前狀態及卡在哪個步驟 | ELK 可用；Payment MCP 待實作 |

---

## 項目群訊息識別速查

> 收到項目群訊息後，先對照此表判斷意圖，再跳到對應 Workflow 執行。
> 來源：Gina 小玥、Lvy and Lvy、Selena、Katelyn✨ 的常見請求格式統計。

### ⚠️ 訂單類型判斷規則

**訂單類型從訊息語境判斷，不是從訂單號格式判斷。**

商戶單號格式可以是任意自定義格式（如 `FAKEID...`、`202603130215`、`9015674` 等），
不能靠格式猜測是充值還是提現。

| 訂單號格式 | 說明 |
|-----------|------|
| `PAY...` | OnePay 內部充值單號（系統產生） |
| `WDR...` | OnePay 內部提現單號（系統產生） |
| 其他任意格式 | **商戶自定義單號**，類型由訊息語境決定 |

**語境判斷優先級：**
1. 訊息明確說「提款/提現/配对/拆弹」→ 提現操作
2. 訊息明確說「充值/recharge」→ 充值操作
3. 不確定時：先問對方確認，不要自行猜測

### 關鍵字 → 操作對照

| 訊息包含 | 意圖 | 對應操作 |
|---------|------|---------|
| `麻烦配对` + `先不回调` / `不回调` | 提現配對，暫不回調 | Workflow 2 Step 2→3；Step 4 **跳過** |
| `麻烦配对` + `回调成功` | 提現配對並回調成功 | Workflow 2 完整流程（Step 2→3→4，RechargeSetting status=1） |
| `麻烦配对` + `回调失败` | 提現配對並回調失敗 | Workflow 2 Step 2→3→4，WithdrawSetting status=0（WDR 號） |
| `麻烦拆弹` / `拆单` / `拆下单` | 拆單配對（餘額池） | Workflow 2B：建多筆充值單分批配對，各自指定回調結果 |
| `PAY...` + `回调成功` / `设置成功` | 充值單回調成功 | RechargeSetting status=1（SKILL Step 4 / Tool 17） |
| `PAY...` + `回调失败` | 充值單回調失敗 | RechargeSetting status=0 |
| 商戶單號（非 PAY...）+ `充值` + `回调成功/失败` / `设置成功` | 充值回調（先查 ELK 取 PAY 號與金額） | Workflow 1 前置 ELK 查詢 → RechargeSetting |
| `WDR...` / 提現訂單號 + `回调成功` | 提現單回調成功 | WithdrawSetting status=1（SKILL Step 5）⚠️ 需已配對 |
| `WDR...` / 提現訂單號 + `再回调` / `补发回调`（無明確成功/失敗） | 補發提現回調 | OrderNotify，不帶 status（replay 當前狀態） |
| `WDR...` / 提現訂單號 + `回调失败` | 提現單回調失敗 | WithdrawSetting status=0 ⚠️ 需已配對 |
| `帮查日志` / `请求日志` / `拿下.*日志` / `回调日志` | 日誌查詢 | ELK `search_logs`，以訂單號或 userid 為關鍵字 |
| `ol环境` + `不需要真实出款` | OL 正式環境測試協助 | ⚠️ 特殊：Workflow 2 流程，但不觸發真實出款，需與 RD 確認 |
| 訂單狀態描述（「又變成等待配對」、「前台顯示失敗」） | 訂單狀態異常回報 | ELK 查訂單狀態，回報原因 |

### 典型訊息格式範例

**提現配對（最高頻）：**
```
9015674 as pre提款，麻烦配对回调成功
9015658 as pre提款，麻烦配对，先不回调
WDR0017292026012115540600000036 麻烦这笔配对，先不回调
```

**充值回調：**
```
PAY0017292025121710343900000037 as pre充值 麻烦回调成功一下
PAY0017292026030416124200000421 xc pre 这笔充值订单麻烦回调失败
```

**提現回調（需已配對才能執行）：**
```
9015178 as pre提款 麻烦回调成功一下
WDR0017612026030913465600000024 麻烦这笔再回调一次
```

**拆單（餘額池配對）：**
```
9014708 麻烦拆弹 一笔回调成功 一笔等超时
WDR... 麻烦拆下单，一个通知建单，一个暂时不通知建单
9015001 麻烦拆弹，配对一笔 一笔不配对 先不回调
```

---

## Workflow 1：訂單回調成功 / 失敗

### 情境說明

項目方在 `/api/auction/get/payment/url`（充值）或 `/api/auction/get/withdraw/url`（提現）建單時，
會提供 `pay_notifyurl`（充值）或 `wdr_notifyurl`（提現）作為接收 onepay 回調的位置。
測試環境中 PM 需要協助手動觸發這個回調，payment 後台執行人工補單/人工失敗後，
系統會將 `returncode` 送到項目方的 notifyurl。

### 執行流程

```
PM 收到請求
  │
  ├─ 【若訂單號為商戶單號（非 PAY... 格式）】先查 ELK 取得 PAY 單號與金額
  │    {channel-index}：pre → pre-channel-cn*，ol → ph-ol-channel-cn*
  │    curl -s -u "$ELK_USER:$ELK_PASS" \
  │      -X POST "http://onepay-kibana.1-pay.co:9200/{channel-index}/_search" \
  │      -H "Content-Type: application/json" \
  │      -d '{
  │            "query": {
  │              "bool": {
  │                "must": [
  │                  {"query_string": {"query": "{商戶單號}"}},
  │                  {"query_string": {"query": "url:\"\/api\/auction\/direct\/recharge\/create\""}}
  │                ]
  │              }
  │            },
  │            "size": 1,
  │            "sort": [{"@timestamp": {"order": "asc"}}],
  │            "_source": ["req_content", "resp_content", "datetime"]
  │          }'
  │    → resp_content 解析 merchant_order → 得到 PAY 單號
  │    → req_content 解析 amount → 得到金額
  │
  ├─ ⚠️ 前置狀態檢查（必做）
  │    **充值訂單（PAY 號或商戶單號）**：呼叫 RechargeCheck API
  │    → POST /api/ai/exec，functionType=RechargeCheck，orderid={PAY單號或商戶單號}
  │    → ⚠️ orderid 不加平台前綴（如 as 平台不加 AS_）
  │    → 讀 response.status（中文顯示名），判斷是否為終態：
  │      - 含「已充值」「金額補單」「未充值」「取消」「充值異常」「系統忙碌」「超過頻率」→ 終態
  │      - 終態 + 對方要求「設置成功/失敗」→ 告知已結束，確認是否要重複操作
  │      - 終態 + 對方要求「再回調/補發」→ 正常執行 OrderNotify
  │      - 非終態 + 對方要求「再回調」→ 告知訂單尚未完成
  │    ⚠️ 不要用 ELK log 推論充值狀態（「通知給平台成功」≠ 訂單成功）
  │
  │    **提現訂單（WDR 號）**：查 ELK cache_withdraw_order
  │    → 從 change_logs.status 判斷：2=成功、3=失敗、5=超時、6=無卡、8=資金池忙、11=無閒置卡
  │    → 終態處理邏輯同上
  │
  ├─ 確認訂單狀態後執行：
  │    充值成功 → RechargeSetting status=1（Tool 17）
  │    充值失敗 → RechargeSetting status=0（Tool 17）
  │    提現成功 → WithdrawSetting status=1（/api/ai/exec）
  │    提現失敗 → WithdrawSetting status=0（/api/ai/exec）
  │
  └─ payment 自動回調 returncode 至項目方的 notifyurl
```

> ⚠️ 這些路由需要 session 認證 + Google 2FA + 對應權限，
> openclaw 需透過 payment 另開的內部 API 接口呼叫（開單 #TBD）

### 回調工具說明

> **兩種回調工具，適用場景不同：**
>
> | 工具 | 適用訂單 | 狀態 |
> |------|---------|------|
> | `set_direct_recharge_result`（Tool 17） | Direct API 充值單（PAY001...） | ✅ 已實作，走 `/api/ai/exec` |
> | `trigger_order_callback` | payment 層訂單（JD...） | ⏳ PENDING，待 RD 開內部 API |

### `/api/ai/exec` 的 functionType 說明

| functionType | 用途 | 備注 |
|---|---|---|
| `RechargeSetting` | 充值人工補單（成功/失敗） | 最常用 |
| `WithdrawSetting` | 提現回調（成功/失敗） | 需已配對 |
| `OrderNotify` | 再次觸發回調給商戶 | **僅在對方明確要求「再次回調」時使用**；系統完成後本就會自動回調，OrderNotify 是額外補發 |
| `RechargeCheck` | 查詢充值訂單狀態（從 DB） | ✅ 已實作，預檢必用 |
| `WithdrawCheck` | 查詢提現訂單狀態（從 DB） | ⏳ PENDING，待 RD 實作 |

#### RechargeCheck 規格（預檢用）

- **用途**：查詢充值訂單當前狀態（直接讀 DB，比 ELK 推論更準確）
- **Endpoint**：`POST {Payment API}/api/ai/exec`

**Request Body：**
```json
{
  "data": "{\"functionType\": \"RechargeCheck\", \"orderid\": \"{PAY單號或商戶單號}\"}"
}
```

**Response：**
```json
{
  "code": 200,
  "merchant_order": "PAY...",
  "status": "系統查核中",
  "amount": "200.00000000",
  "process_amount": "202.00000000",
  "tx_amount": "0.00000000",
  "create_time": "2026-03-19T10:47:31.000000Z",
  "update_time": "2026-03-19T10:47:39.000000Z",
  "platform_name": "平台名稱",
  "platform_code": "JSIANTEST01",
  "message": "請求成功"
}
```

**orderid 說明**：支援 PAY 單號及商戶單號（不加平台前綴，如 `as` 平台不加 `AS_`）。

**終態判斷**：`status` 欄位為中文顯示名，含以下任一關鍵字即為終態（不應再操作）：
- `已充值` → 成功
- `金額補單` → 人工補單成功（含「金額補單(Ai)」）
- `未充值` → 失敗（含「未充值-用户取消」「未充值-等待中取消」）
- `取消` → 已取消
- `充值異常` → 異常終止
- `系統忙碌未收單` → 無可用卡
- `超過頻率限制` → 頻率限制

> ⚠️ **不要用 ELK log 推論充值狀態**（如「通知給平台成功」≠ 訂單成功）。RechargeCheck 直接讀 DB，是唯一可靠的充值狀態來源。

#### OrderNotify 規格

- **Endpoint**：`POST {Payment API}/api/ai/exec`（同 RechargeSetting/WithdrawSetting）
- **支援單號**：PAY 單號、WDR 單號、商戶單號（三者皆可）

**Request Body：**
```json
{
  "data": "{\"functionType\": \"OrderNotify\", \"orderid\": \"{訂單號}\"}"
}
```

**成功響應：**
```json
{
  "code": 200,
  "message": "請求成功"
}
```

**使用原則：**
- 系統在充值/提現完成後已自動回調，**不需要主動觸發**
- 僅當對方說「幫我**再**回調一下」才執行
- 不需要帶 status，只帶 orderid 即可

### MCP Tool：`trigger_order_callback`

**[PENDING - 待 RD 提供 Payment 內部 API 接口]**

預期輸入參數：

| 參數 | 必填 | 說明 |
|------|------|------|
| `order_type` | ✅ | `recharge` / `withdraw` |
| `order_no` | 擇一 | payment 層訂單號 |
| `order_id` | 擇一 | 後台 rechargeId / withdrawId |
| `callback_result` | ✅ | `success` / `failed` |
| `environment` | ✅ | `dev` / `pre` / `beta`（正式環境拒絕） |

**對應 payment 後台路由（已確認存在）：**

| 訂單類型 | 結果 | 路由 |
|----------|------|------|
| 充值 | success | `POST /record/cardPayManualAcceptByAmountReview/{rechargeId}` |
| 充值 | failed | `POST /record/cardPayManualFail/{order}` |
| 提現 | success | `POST /set/withdraw/success/{withdrawId}` |
| 提現 | failed | `POST /set/withdraw/error/{withdrawId}` |

---

## Workflow 2：充值建單配對提現單

### 情境說明

項目方在自己的前台申請提現訂單，通過風控審核後通知 onepay。
onepay 收到提現單後，AI PM 建立充值單，payment 自動在卡池內撮合配對，
配對成功後再透過 Payment MCP 執行人工補單，觸發回調通知雙方。

### 項目群訊息格式

項目方在群內的請求格式範例：
```
9015674 as pre提款，麻烦配对回调成功
```

解析規則：

| 欄位 | 範例值 | 說明 |
|------|--------|------|
| 商戶單號 | `9015674` | 項目方的提現訂單號（原始） |
| 平台代碼 | `as` | 對應 onepay 的 memberid／平台識別 |
| 環境 | `pre` | `pre` / `beta` / 不帶=正式(ol) |
| 操作 | `提款，配对回调成功` | 提現 + 要求配對並回調成功 |

### 平台單號前綴規則

部分平台的商戶單號需加前綴才能在 onepay 系統內查詢：

| 平台 | 前綴規則 | 範例 |
|------|----------|------|
| `as` | 加 `AS_` 前綴 | `9015674` → `AS_9015674` |
| **未指定平台代碼** | **不加前綴** | `202603110102` → `202603110102` |
| 其他平台 | 待補充 | — |

> 查 ELK 提現單時，記得使用加前綴後的訂單號。充值單及 API 呼叫（RechargeCheck / RechargeSetting）不加前綴。
> 若訊息中未帶平台代碼（如 `202603110102 pre提款`），直接用原始單號查詢，不加前綴。

### 執行流程

```
Step 1  解析訊息
        → 取得：平台(as)、商戶單號(AS_9015674)、環境(pre)、操作(配對+回調成功)

Step 2  查 ELK 確認提現單狀態 + 判斷池類型
        → 2.1 index: {env}-channel-cn*，keyword: "{orderNo} AND cache_withdraw_order"
             解析建立 log 取 amount/user_id/break_mode/withdraw_order/break_list 初始值
        → 2.1b ⚠️ **必做**：用 WDR 號重查（break_list 更新 log 僅含 WDR 號，商戶單號查不到）
             keyword: `"{WDR_NO}" AND cache_withdraw_order`（WDR 號需加引號做精確匹配），取最新有 break_list 的 log
             若更新 log 的 break_list.new status ≠ 2.1 的 status → 以更新 log 為準（見 SKILL.md Step 2.1b）
        → 解析 change_logs，檢查提現單當前狀態：

        ⚠️ 前置狀態檢查（必做）：
        ❗ break_list[0].status=1（PLATFORM_REVIEW）本身不代表仍在審核中，不可直接用它判斷
           集團風控判斷必須查 channel-cn 通知（見下方集團風控確認步驟）
        ❗ **兩個 status 不能混淆**：`change_logs.status`（提現單整體狀態，2=成功/終態）≠ `change_logs.break_list[0].status`（集團風控/池路由狀態，2=WAIT=搶單池路由）
           ELK 查到 break_list.status=2 不代表訂單已成功，必須確認是哪個 status 欄位
        ❗ **ELK「成功」字樣不代表訂單付款完成**：`建立資金池提現單(審核成功)` = 集團風控通過；infogen `returncode:"00"` = API 正常；均非最終付款
        → 從 change_logs 的 status 或最新 log 判斷提現單當前狀態
        → 若提現單已在終態（**change_logs.status**=2 成功 / =3 失敗 / =5 超時 / =6,8,11 異常終止）：
          - 停止操作，告知對方：「⚠️ {單號} 已{成功/失敗/超時}，無需再配對」
        → 若提現單不在可配對狀態（非 WAIT_MAPPING=13）：
          - 告知對方當前狀態，確認是否需要其他操作

        確認可配對後，集團風控確認 + 判斷池類型：
        ⚠️ 通知類型由 break_list[0].status 決定，不是 break_mode
        → status=2（WAIT）：PLATFORM_REVIEW 已過審，路由為搶單池 → 直接走 Step 3（即使 break_mode=3）
        → status=1（PLATFORM_REVIEW，不論 break_mode）：
            查「商戶提現風控審核通知」AND break_list[0].platformOrder，有命中 = 已過審
            有命中 → 重查最新 break_list.new[0].status：
              - status=2（WAIT）→ 搶單池 → 走 Step 3
              - status=8（WAIT_BREAK_RISK）→ 餘額池 → 走 Workflow 2B
              - 其他 → 依 break_mode=3 走 Workflow 2B；否則走 Step 3
            無命中 → 停止配對，告知：「⚠️ {單號} 集團風控過審中，待審批通過後方可配對」
        → status=8（WAIT_BREAK_RISK）：
            查「商戶提現等待風控審核通知」AND withdraw_order（WDR號），有命中 = 已過審
            有命中 → 走 Workflow 2B（餘額池）
            無命中 → 停止配對，告知：「⚠️ {單號} 集團風控過審中，待審批通過後方可配對」
        → 其他 status → 無集團風控阻攔：break_mode=3 走 Workflow 2B；其他走 Step 3
        ⚠️ pool_withdraw_balances 記錄也在 channel-cn，不是 pool-cn

Step 3  查詢 ELK 取得提現資訊（channel index）
        → index: {env}-channel-cn*（pre環境 → pre-channel-cn*）

        3.1 查提現基本資訊
        → keyword: "{任意ID} AND cache_withdraw_order"
          ✅ 商戶號、WDR號、wdr_userid 均可
        → 解析 _source.change_logs（JSON string，需先 json.loads()）
        → 取 change_logs.amount（提現金額）、change_logs.user_id（提現 userid）
        → 取 change_logs.break_list[0].auctionMode（⭐ 充值 auction_mode 必須與此一致）

        3.2 查提現單的 wdr_memberid ⭐ 關鍵
        → keyword: "wdr_memberid AND {orderNo}"
        → 找「商戶取得極速提現中間站網址資訊」那筆 log
        → 從 message 的 params JSON 解析 wdr_memberid
        → ⚠️ 查 wdr_memberid 時，勿用「商戶提現風控審核通知」當 keyword（不穩定）；改用「wdr_memberid AND {orderNo}」
           此備註只限 Step 3.2（查 memberid），不影響 Step 2 的集團風控通知查詢

Step 4  建立充值單（Direct API）
        → POST /api/auction/direct/recharge/create
        → memberid 使用提現單的 wdr_memberid（⭐ 最關鍵，不是從 secrets 直接選）
        → auction_mode 從 ELK change_logs.break_list[0].auctionMode 讀取，不能寫死
        → ⚠️ 充值 userid 必須與提現單 userid 不同（建議用 {YYYYMMDD}0201 起）
        → ⚠️ 必須帶 userip 外層參數，及完整 ext（含 userip、betrate 等），格式詳見下方 API 文件
        → 判斷配對成功：pay_bankcard.bank_account 不為 null（⚠️ dict 存在但全 null = 未配對）
        → returncode=00 只代表建單成功，不代表配對成功
        → ⭐ PAY 單號從 response 的 merchant_order 欄位取得（不是 orderid 欄位）

Step 5  執行回調（Channel AI Exec）✅ 已實作
        → POST https://{env}.channel.1-pay.co/api/ai/exec
        → ⚠️ 搶單池回調成功 vs 失敗使用不同 functionType：
        → 回調成功：RechargeSetting（對 PAY 單號）
          {"data": "{\"functionType\":\"RechargeSetting\",\"orderid\":\"{merchant_order}\",\"status\":\"1\",\"amount\":\"{amount}\",\"reason\":\"人工補單成功\"}"}
        → 回調失敗：WithdrawSetting（對 WDR 號；WDR 號 = Step 3.1 change_logs.withdraw_order）
          {"data": "{\"functionType\":\"WithdrawSetting\",\"orderid\":\"{withdraw_order}\",\"status\":\"0\",\"amount\":\"{amount}\",\"reason\":\"人工補單失敗\"}"}
          ⚠️ 失敗不能用 RechargeSetting status=0，否則提現單會重新進配對池
        → ⚠️ 必須先確認 Step 4 配對成功（bank_account 非 null）再執行
        → ⚠️ 此 API 無論是否真正執行成功都回 {"code":200}，不能用回應判斷結果
        → ⚠️ 餘額池（Workflow 2B）全程用 WithdrawSetting（子 WDR 號），見 Workflow 2B
```

### API：`POST /api/auction/direct/recharge/create`（Direct API）

> ✅ 使用 Direct API，需自帶金額（從 ELK 查得提現金額後填入）。
> 系統自動從提現池撮合，金額必須與提現單完全一致。

| 參數 | 必填 | 說明 |
|------|------|------|
| `memberid` | ✅ | 商戶 ID |
| `orderid` | ✅ | 自動產生，格式：`test_auction_recharge_{timestamp_ms}` |
| `amount` | ✅ | 提現金額（從 ELK 查得） |
| `datetime` | ✅ | 格式：`Y-m-d H:i:s` |
| `auction_mode` | ✅ | `1`（JFB）/ `2`（Alipay）/ `3`（WeChat） |
| `notifyurl` | ✅ | 回調 URL |
| `infourl` | ✅ | 查詢 URL |
| `userid` | ✅ | 充值使用者 ID（格式見下方，**不可與提現單 userid 相同**） |
| `userip` | ✅ | 使用者 IP（payment 強制驗證，不可省略） |
| `ext` | ❌ | 擴展欄位（**必須是 JSON 字符串，不是 object**） |
| `pay_bankcode` | ❌ | 銀行/支付類型代碼（如 `JFB`） |
| `sign` | ✅ | MD5 簽名（見下方算法） |

### userid 產生規則

格式：`{YYYYMMDD}{4位序號}`，每次請求遞增，避免觸發風控重複偵測。

範例：`202603060201`、`202603060202`、`202603060203`...

> ⚠️ **關鍵配對規則**：充值單的 `userid` 絕對不能與提現單的 `userid` 相同，否則系統無法配對成功。
> 建議充值 userid 序號從 0201 開始，與提現 userid（0101起）區隔。

### ext 格式

> ⚠️ `ext` 必須是 **JSON 字符串**（先 `json.dumps()` 再放入 payload），不能直接放 object。

```json
{
  "userid":       "{userid}",
  "username":     "{userid}",
  "userip":       "23.12.8.1",
  "betrate":      0.9,
  "wwdepositsum": 20000,
  "betcnt":       100,
  "pwtimerange":  180,
  "regddate":     "2020-01-01 12:00:00",
  "depositcnt":   200,
  "depositsum":   "3000000",
  "depositcnt2":  200,
  "depositsum2":  "3000000",
  "depositcnt3":  200,
  "depositsum3":  "3000000",
  "withdrawsum":  "2000000",
  "wwbetsum":     30000,
  "balance":      0,
  "profitsum":    -100,
  "agent":        "SKKK99@as> DFFF02@as>DF99@as",
  "deviceid":     "Win10-Chrome-{random}",
  "realName":     "{userid}"
}
```

### sign 簽名算法

```
// Direct API signMap 順序：memberid → orderid → amount → datetime → notifyurl → infourl
string = memberid + orderid + amount + datetime + notifyurl + infourl + secret_key
sign   = md5(string)
```

範例（Python）：
```python
import hashlib, json
raw  = memberid + orderid + amount + datetime + notifyurl + infourl + secret_key
sign = hashlib.md5(raw.encode()).hexdigest()

# ext 必須先序列化為字符串
ext_str = json.dumps(ext_dict, ensure_ascii=False)
```

> ✅ Milestone 達成（2026-03-06）：Direct API 建立充值單並成功配對提現單。
> ✅ Milestone 達成（2026-03-11）：完整流程打通，含 Channel AI Exec 回調（set_direct_recharge_result）。
> 詳細流程與腳本見 `skills/onepay-direct-api/SKILL.md`

---

## Workflow 2B：拆單配對（餘額池）

### 與 Workflow 2 的差異

| | Workflow 2（搶單池） | Workflow 2B（餘額池） |
|---|---|---|
| 進池條件 | 平台拆單模式 ≠ MAPPING | 平台拆單模式 = MAPPING（mode=3） |
| 充值單數量 | 1 筆，金額 = 提現單金額 | N 筆，金額加總 = 提現單金額 |
| 回調方式 | 成功：RechargeSetting status=1（PAY 號）；失敗：WithdrawSetting status=0（WDR 號） | 每筆子單 WithdrawSetting（對子 WDR 號，status=1/0） |

> ⚠️ 提現單是否進搶單池或餘額池，**由平台設定決定，不是 Direct API 參數**。
> ⚠️ 池路由判斷以 `break_list[0].status` 為主，`break_mode + pool 查詢` 作輔助確認：
> - `break_list[0].status=2`（WAIT）→ **搶單池**（即使 break_mode=3 也以此為準）
> - `break_list[0].status=8`（WAIT_BREAK_RISK）→ **餘額池**
> - `break_list=null` 或 status 為空/其他 → 依 break_mode + pool 查詢雙重確認：
>   - Step A：`break_mode ≠ 3` → 搶單池
>   - Step A：`break_mode = 3` → 可能餘額池，繼續 Step B
>   - Step B：WDR 號 + `remaining_balance` 有結果 → 確認餘額池；無結果 → 搶單池
>
> ⚠️ **兩個 status 不能混淆**：`change_logs.status`（訂單狀態，2=已成功）≠ `break_list[0].status`（路由狀態，2=WAIT=搶單池）。

### 情境說明

項目群用「麻烦拆弹」表示需要拆單配對，通常會指定每筆子單的回調結果：
```
9014708 麻烦拆弹 一笔回调成功 一笔等超时
WDR... 麻烦拆下单，一个通知建单，一个暂时不通知建单
9015001 麻烦拆弹，配对一笔 一笔不配对 先不回调
```

### 執行流程

```
Step 1  解析訊息（同 Workflow 2）
        → 取平台、訂單號、環境、各子單的回調指令

Step 2  查詢 ELK 取得提現資訊（全部查 channel-cn）
        ⚠️ pool_withdraw_balances 的 log 也在 channel-cn，不是 pool-cn

        2.1 確認提現單狀態 + 是否為餘額池（兩個條件都要符合）
        Step A：查 cache_withdraw_order
        → index: {env}-channel-cn*
        → keyword: "{任意ID} AND cache_withdraw_order"
          ✅ 商戶號（FAKEID...、9015674 等）、WDR號、wdr_userid 均可，ELK 全文搜尋都能命中

        ⚠️ 前置狀態檢查（同 Workflow 2）：
        → 若提現單已在終態（status=2 成功 / status=3 失敗 / status=5 超時 / status=6,8,11 異常終止）→ 停止操作，告知對方
        → 集團風控確認（同 Workflow 2）：依 break_list[0].status 決定通知類型（詳見 Step 2 集團風控確認）
        → 若不在可配對狀態 → 告知對方當前狀態

        確認可配對後，判斷池類型：
        → 讀 change_logs.break_mode：
          - break_mode ≠ 3 → 搶單池，直接改走 Workflow 2
          - break_mode = 3 → 可能是餘額池，繼續 Step B 雙重確認
        ⚠️ break_mode 是字串 '3' 不是整數 3，腳本比較時必須用 str(break_mode) == '3'

        Step B：確認 pool 實際存在（雙重確認）
        → keyword: "{WDR號} AND remaining_balance"（同 Step 2.2 的方法）
        → 有結果 → ✅ 確認為餘額池，繼續往下
        → 無結果 → ⚠️ pool 記錄未找到（break_mode=3 但 channel-cn 無對應 pool record）
          先確認 break_list[0].status：
          (a) status=2（WAIT）→ PLATFORM_REVIEW 已過審，路由為**搶單池** → 直接改走 Workflow 2
          (b) status=1（PLATFORM_REVIEW 未過審）→ pool 待過審後才建立 → 等候集團風控審批
          (b2) status=8（WAIT_BREAK_RISK）→ 餘額池等待集團風控審批中，pool 待過審後才建立 → 停止，等候集團風控審批
          (c) 其他（break_list=null 或 status 為空）→ 提現單剛建立，pool 建立有數秒延遲 → 等待 5 秒後重查一次；仍無結果 → 改走 Workflow 2

        同時從 change_logs 取得：
          - withdraw_order：⭐ OnePay WDR 號（後續查 pool 必須用這個）
          - platform_order：商戶訂單號
          - amount：提現總金額
          - user_id：提現 userid
          - bank_code：推導 auction_mode（見下方）

        2.2 查 pool 狀態及 auction_mode
        → keyword: "{change_logs.withdraw_order} AND remaining_balance"
        → ⚠️ 必須用 WDR 號（從 2.1 的 withdraw_order 欄位取得）
        → ⚠️ 不能用 "pool_withdraw_balances" 當關鍵字（底線被 ELK 拆字，搜不到）
        → 找最新的「修改 pool_withdraw_balance」log（有 .old/.new 的版本）→ 取當前狀態：
          - remaining_balance.new：剩餘未配對金額
          - match_withdraws.new：已配對金額列表（不可重複使用相同金額）
        → 找「新增 pool_withdraw_balances」log → 取初始設定：
          - options.auctionMode：⭐ 直接用這個，不需要從 bank_code 推導
          - options.maxWithdrawCount：最多可拆幾筆
          - options.rejectWithdrawAmounts：禁用金額列表
          - expired_at：⭐ 池子到期時間，**必須確認**
        ⚠️ 若距 expired_at 不足 2 分鐘，立刻回報 Ian「池子即將到期，請重新建提現單」，不要繼續嘗試建充值單

        2.3 查 wdr_memberid
        → keyword: "wdr_memberid AND {任意ID}"
        → 從「商戶取得極速提現中間站網址資訊」log 解析

Step 3  確認拆單金額
        → 優先從訊息中解析（對方有時會指定金額）
        → 若未指定：自行決定，規則：
          - 各子單加總 = remaining_balance（非總金額，避免重覆配對已配對部分）
          - 每筆金額不可與 match_withdraws 已有金額重複
          - ⚠️ 各子單金額不可相同（餘額池規則：同金額不能配對兩次，無論是否逐單完成）
            例如 2000 不能拆 1000+1000，改拆 1200+800 或其他不同金額組合
          - 筆數不可超過 options.maxWithdrawCount
          - 建議拆成 2 筆，金額盡量整數（例如 2000 → 1200+800）

Step 4–6  逐筆執行（每筆子單完整走完再處理下一筆）
        ⚠️ 不要一次建好全部充值單再回調，必須「一筆建完+回調完成，才建下一筆」

        ── 每筆子單的執行順序 ──

        4.1 建立充值單（Direct API）
            → 每筆充值單必須用不同的 userid 和 username
              格式：userid = {YYYYMMDD}0201、0202...；username 同 userid
              ⚠️ 兩者都要換，只換 userid 不換 username → returncode: 13「同用户重复建单」
            → auction_mode 與提現單一致（從 Step 2.1 讀取）
            → memberid 使用提現單的 wdr_memberid（Step 2.3）
              ⚠️ 從 secrets 找「memberid 值等於 wdr_memberid」的那筆，不是取第一筆
              ⚠️ memberid 錯 → returncode: '03'，直接修正後重試，勿繼續用錯誤值
            → 確認配對成功：pay_bankcard.bank_account 不為 null
            → 若用戶指定「一笔不配对」：該筆不建

        4.2 取得子提現單號（⭐ 每次配對後必做）
            → 每次充值配對成功，系統會建立一張子WDR單，WithdrawSetting 必須用子WDR號
            → 子WDR號規則：
              - 第 1 筆配對：子WDR號 = 母單WDR號（相同）
              - 第 2 筆起：子WDR號 = 新建的 WDR號（不同於母單）
            → 第 2 筆起的查詢方式：
              index: {env}-channel-cn*
              keyword: "{母單WDR號} AND wdr_mainorder"
              ⚠️ 子WDR號在 req_content 欄位，不是 change_logs（change_logs 可能為空）
              從 req_content 解析 withdraw_order 欄位即為子WDR號
            → req_content 格式範例：
              {"withdraw_order":"WDR...子單號","wdr_mainorder":"WDR...母單號",
               "wdr_amount":800,"wdr_mainamount":2000,"wdr_userid":"..."}

        4.3 執行 WithdrawSetting（該子單的回調指令）
            → orderid 填子WDR號（Step 4.2 取得）⚠️ 不是母單號
            → 回調成功：WithdrawSetting status=1
            → 回調失敗：WithdrawSetting status=0
            → 不回調 / 等超時：跳過，直接建下一筆
            ⚠️ 餘額池一律只打 WithdrawSetting，**不打 RechargeSetting**
               搶單池（Workflow 2）回調成功用 RechargeSetting，回調失敗也用 WithdrawSetting
               拆單流程裡完全不打 RechargeSetting
               唯一例外：對方明確說「充值單也要回調」才另外打 RechargeSetting（PAY 號，status 依指示）
            ⚠️ 同一張子WDR先打 status=1 再打 status=0 → 404，無法修正；順序要一次到位

        ── 所有子單完成後結束 ──
```

### 典型場景對照

| 用戶指令 | 執行動作 |
|---------|---------|
| `一笔回调成功 一笔等超时` | 子單1：建單→配對→WithdrawSetting status=1；子單2：建單→配對→跳過回調 |
| `一笔成功一笔失败` / `一笔回调成功 一笔回调失败` | 子單1：建單→配對→WithdrawSetting status=1；子單2：建單→配對→WithdrawSetting status=0 |
| `一个通知建单，一个暂时不通知建单` | 子單1：建單→配對→WithdrawSetting；子單2：建單→配對→跳過回調 |
| `配对一笔 一笔不配对 先不回调` | 只建子單1→配對→跳過回調；子單2 不建 |
| `拆弹 先不回调` | 每筆：建單→配對→跳過回調（全部完成後依指令決定是否打 WithdrawSetting） |

> ⚠️ **拆單全程不打 RechargeSetting**，除非對方明確要求充值單也要回調。

---

## Workflow 3：查詢訂單狀態

### 情境說明

客戶在群內提供訂單號，詢問訂單目前狀態（卡在哪步、有無失敗、回調是否發出）。
目前可透過 ELK 查詢 log 進行診斷；後續 Payment MCP 完成後可直接查詢訂單資料。

### 3-A：ELK 查詢（目前可用）

使用 `{env}-channel-cn*` index（pre → `pre-channel-cn*`，ol → `ph-ol-channel-cn*`），以訂單號為關鍵字搜尋相關 log：

```
查詢充值狀態：
  keyword: {order_no} + "充值"
  重點看：領單/配卡是否成功、有無回調記錄

查詢提現狀態：
  keyword: {order_no} + "提現"
  重點看：配對成功/失敗、有無回調記錄
```

配合 elk-keywords.md 的情境對照（情境 1、2、4）進行診斷。

### MCP Tool：`search_logs`（ELK，目前可用）

```json
{
  "name": "search_logs",
  "description": "查詢 ELK 日誌。可用 order_no 搜尋特定訂單的完整 log 鏈路，或用關鍵字搜尋特定類型錯誤。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "keywords": {
        "type": "array",
        "items": { "type": "string" },
        "description": "查詢關鍵字列表（OR 邏輯）。支援中文，可直接輸入 log 訊息關鍵字或訂單號。"
      },
      "index": {
        "type": "string",
        "description": "ELK index 名稱。不填則預設查 ph-ol-channel-cn*。",
        "default": "ph-ol-channel-cn*"
      },
      "environment": {
        "type": "string",
        "enum": ["ol", "pre", "beta"],
        "description": "環境。ol=正式(ph-ol-)，pre=預發佈(pre-)，beta=beta(beta-)。自動替換 index 前綴。",
        "default": "ol"
      },
      "start_time": {
        "type": "string",
        "description": "開始時間，ISO format，例如 2026-03-06T00:00:00+08:00。不填則用 end_time 往前推 days。"
      },
      "end_time": {
        "type": "string",
        "description": "結束時間，ISO format。不填則為目前時間。"
      },
      "days": {
        "type": "integer",
        "description": "查詢天數（當 start_time 未提供時使用）。",
        "default": 1
      },
      "size": {
        "type": "integer",
        "description": "返回結果上限。",
        "default": 100,
        "maximum": 10000
      }
    },
    "required": ["keywords"]
  }
}
```

**ELK Index 對照表：**

| 服務 | 正式（ol） | 預發佈（pre） | Beta |
|------|-----------|--------------|------|
| channel（infogen/payment-flow） | `ph-ol-channel-cn*` | `pre-channel-cn*` | `beta-channel-cn*` |
| paymentpool | `ph-ol-pool-cn*` | `pre-pool-cn*` | `beta-pool-cn*` |
| risk_api | `ph-ol-risk-api` | `pre-risk-api` | `beta-risk-api` |
| payment（人工補單/變更卡） | `ph-ol-payment-cn` | `pre-payment-cn` | `beta-payment-cn` |

### 3-B：Payment MCP 查詢（待 RD 實作）

**[PENDING - 待 RD 提供 Payment MCP 接口規格]**

預期工具名稱：`get_order_status`

預期輸入參數：

| 參數 | 必填 | 說明 |
|------|------|------|
| `order_no` | 擇一 | 訂單號 |
| `order_id` | 擇一 | 後台 ID |
| `order_type` | ✅ | `recharge` / `withdraw` |
| `environment` | ✅ | `ol` / `pre` / `beta` |

---

## ELK 日誌查詢情境對照

> 以下情境及關鍵字均直接來自各服務原始碼，為實際寫入 log 的訊息。

### Index 對照

| 服務 | 正式 Index | 環境前綴替換規則 |
|------|-----------|----------------|
| paymentpool | `ph-ol-pool-cn*` | 替換 `ph-ol` → `pre` / `beta` |
| risk_api | `ph-ol-risk-api` | 替換 `ph-ol` → `pre` / `beta` |
| channel（infogen/payment-flow） | `ph-ol-channel-cn*` | 替換 `ph-ol` → `pre` / `beta` |
| payment（人工補單/變更卡） | `ph-ol-payment-cn` | 替換 `ph-ol` → `pre` / `beta` |

---

### 情境 1：充值失敗

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `充值單: %s 領單失敗` | ERROR | 搶單失敗 | ph-ol-pool-cn* |
| `channel %s create recharge failed cause` | WARNING/NOTICE | 特定 channel 建單失敗 | ph-ol-pool-cn* |
| `ThirdPartyFilter 過濾後無可用卡片` | WARNING/INFO | 卡池無可用卡 | ph-ol-pool-cn* |
| `搶單充值建單請求失敗` | ERROR | infogen 呼叫 payment 建單失敗 | ph-ol-channel-cn* |
| `極速充值三方回應配卡失敗` | ERROR | 三方回應後配卡失敗 | ph-ol-channel-cn* |
| `充值搶單通知資金池更新狀態失敗` | ERROR | 充值完成但通知 paymentpool 失敗 | ph-ol-channel-cn* |

### 情境 2：提現失敗

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `極速提現配對失敗轉提現先決` | WARNING | 極速提現配對失敗 | ph-ol-channel-cn* |
| `搶單提現建單請求失敗` | ERROR | infogen 建立提現單失敗 | ph-ol-channel-cn* |
| `搶單提現確認到帳請求失敗` | ERROR | 確認到帳操作失敗 | ph-ol-channel-cn* |
| `極速提現單逾時並重回配對池異常` | ERROR | 逾時後重回配對池失敗 | ph-ol-channel-cn* |

### 情境 3：銀行卡被鎖定

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `微信配到充值單，但所屬銀行卡已被鎖卡` | WARNING | 微信匹配後發現卡已鎖定 | ph-ol-pool-cn* |
| `簡訊配到充值單，但所屬銀行卡已被鎖卡` | WARNING | 簡訊匹配後發現卡已鎖定 | ph-ol-pool-cn* |
| `銀行卡 %s 沒等到餘額更新` | WARNING | 卡片餘額更新超時 | ph-ol-pool-cn* |

### 情境 4：回調失敗（最常用）

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `發送充值結果通知給平台失敗` | INFO | 充值回調商戶失敗（含 http status） | ph-ol-channel-cn* |
| `發送充值結果通知給平台成功` | INFO | 充值回調成功（確認有無此記錄） | ph-ol-channel-cn* |
| `通知網址異常，終止充值通知程序` | INFO | 商戶回調 URL 有問題 | ph-ol-channel-cn* |
| `發送提現結果通知給平台失敗` | INFO | 提現回調商戶失敗 | ph-ol-channel-cn* |
| `發送提現結果通知給平台成功` | INFO | 提現回調成功（確認有無此記錄） | ph-ol-channel-cn* |

### 情境 5：風控異常

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `取得風控資料失敗` | ALERT | 風控查詢失敗 | ph-ol-channel-cn* |
| `risk bankcard update failed` | WARNING | 風控銀行卡更新失敗 | ph-ol-pool-cn* |
| `risk record insert failed` | WARNING | 風控記錄寫入失敗 | ph-ol-pool-cn* |

### 情境 6：SMS / 微信帳單配對失敗

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `嘗試配對微信與充值單` | INFO | 正在嘗試配對 | ph-ol-pool-cn* |
| `嘗試配對簡訊與充值單` | INFO | 正在嘗試配對 | ph-ol-pool-cn* |
| `微信配不到轉帳單` | WARNING | 找不到對應充值單 | ph-ol-pool-cn* |
| `簡訊配不到轉帳單` | WARNING | 找不到對應充值單 | ph-ol-pool-cn* |

### 情境 7：第三方連線異常

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `查單: %s 與第三方連線異常` | WARNING | 查詢第三方訂單時連線失敗 | ph-ol-pool-cn* |
| `(im) 接收 IM 訊息異常` | ERROR | IM 訊息接收失敗 | ph-ol-channel-cn* |
| `取得cashpool token發生例外錯誤(ginbao)` | ERROR | 取得 Ginbao token 失敗 | ph-ol-channel-cn* |

### 情境 8：圖片辨識 / OCR

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `圖片辨識發生錯誤, 轉AI辨識` | WARNING | 一般辨識失敗，改用 AI | ph-ol-channel-cn* |
| `ai 圖片ocr比對金額異常` | INFO | AI 辨識後金額不符 | ph-ol-channel-cn* |
| `open ai validation error` | ERROR | OpenAI 驗證失敗 | ph-ol-channel-cn* |

### 情境 9：前端（infogen）問題

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `搶單充值建單請求失敗, userid=` | ERROR | 前端建立充值單失敗 | ph-ol-channel-cn* |
| `搶單提現建單請求失敗, code=` | ERROR | 前端建立提現單失敗 | ph-ol-channel-cn* |
| `極速提現頁面請求失敗` | ERROR | 前端請求提現頁面失敗 | ph-ol-channel-cn* |

### 情境 10：業務自動化指標（AI GB）

| 關鍵字 | 意義 | Index |
|--------|------|-------|
| `GetGbMchParams` | 呼叫 AI 次數 | ph-ol-channel-cn* |
| `DepositChange` | 回款 USDT | ph-ol-channel-cn* |
| `BankcardAlter` | 支付寶/微信下卡 | ph-ol-channel-cn* |
| `JfbWiReg` | 支付寶/微信上卡 | ph-ol-channel-cn* |

### 情境 11：匯率拉取失敗

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `火幣拉取資料失敗` | ERROR | 火幣 API 無法取得匯率 | ph-ol-channel-cn* |
| `歐易拉取資料失敗` | ERROR | OKEx API 無法取得匯率 | ph-ol-channel-cn* |
| `幣安拉取資料失敗` | ERROR | Binance API 無法取得匯率 | ph-ol-channel-cn* |

### 情境 12：金寶 SSR 連線

| 關鍵字 | 等級 | 意義 | Index |
|--------|------|------|-------|
| `金寶 SSR 連線存活檢查(連線已過期)` | INFO | SSR 連線已過期 | ph-ol-pool-cn* |
| `金寶 SSR 連線存活檢查(資料異常)` | INFO | SSR 連線資料異常 | ph-ol-pool-cn* |

---

## 快速排查對照

| 使用者反映 | 優先查詢的 ELK 關鍵字 | 對應 Workflow |
|-----------|---------------------|--------------|
| 「充值了但沒到帳」 | `ThirdPartyFilter 過濾後無可用卡片` → `領單失敗` | Workflow 3 |
| 「提現一直沒收到」 | `極速提現配對失敗` → `發送提現結果通知給平台` | Workflow 3 |
| 「沒收到回調通知」 | 訂單號 + `通知給平台` | Workflow 3 → Workflow 1 |
| 「幫我回調成功/失敗」 | 先查訂單狀態，再執行人工補單 | Workflow 1 |
| 「幫我配對測試提現單」 | 確認提現單號 + 金額，建立充值單 | Workflow 2 |

---

## 待整合項目（PENDING）

下列項目待 RD 實作 Payment MCP 後，由 PM 提供規格文件併入本文檔：

- [ ] `trigger_order_callback` 的 Payment MCP 接口規格（充值/提現 人工補單/失敗）
- [ ] `get_order_status` 的 Payment MCP 接口規格（訂單狀態查詢）

> 備注：
> - ELK 查詢（`search_logs`）目前已可實作，不依賴 Payment MCP。
> - Workflow 2 充值建單直接呼叫 payment Direct API，不需 MCP。
