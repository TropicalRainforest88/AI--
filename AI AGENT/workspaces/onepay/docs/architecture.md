# OnePay 系統架構文檔（openclaw AI Agent 版）

## 1. 系統概覽

OnePay 是針對中國大陸市場的支付處理平台，以**極速（Auction 模式）**為主要收付款流程。系統由 5 個微服務組成，透過 REST API 串接，搭配 Redis、WebSocket、隊列異步處理。

**核心目標：** 極速撮合使用者與收款銀行卡，完成快速充提款。

---

## 2. 服務地圖

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

---

## 3. 各服務職責與健康指標

### 3.1 infogen-micro-service（極速入口）

**職責：**
- 使用者操作的唯一前端介面
- 建立極速充值/提款請求
- 收據截圖上傳（七牛雲）
- 透過 WebSocket（Reverb）推送交易狀態

**健康指標：**
- `/op1/api/auction/payment/{code}/as/create` 成功率
- WebSocket 連線數量
- 七牛雲上傳成功率

**異常徵兆：**
- create API 大量 5xx → 往 payment 方向排查
- WebSocket 斷線 → Reverb 服務狀態
- 截圖上傳失敗 → 七牛雲 quota 或網路問題

---

### 3.2 payment（訂單中心）

**職責：**
- 充值/提款訂單的完整生命週期管理
- 極速（Auction）模式的訂單路由
- 商戶整合與 iframe 頁面生成
- 透過 Laravel Horizon 處理異步隊列

**健康指標：**
- 訂單建立成功率
- Horizon 隊列積壓量（正常應接近 0）
- 訂單狀態流轉時間（建立→完成）

**異常徵兆：**
- Horizon 隊列積壓暴增 → Worker 掛掉或 Redis 異常
- 訂單建立失敗 → paymentpool 無可用卡 或 risk_api 拒絕
- 訂單長時間停留「處理中」→ payment-flow 異常或回調失敗

---

### 3.3 paymentpool（卡池）

**職責：**
- 管理可用收款銀行卡池
- 極速 Auction 競拍：為每筆訂單分配最合適的收款卡
- 管理資金池餘額

**健康指標：**
- 可用卡數量（active cards in pool）
- Auction 成功分配率
- Echo Server WebSocket 連線數

**異常徵兆：**
- 可用卡數量歸零 → 所有充值訂單無法進行（**最高優先級告警**）
- Auction 分配失敗率上升 → 卡池不足或卡狀態異常
- WebSocket (Echo Server port 6001) 中斷 → 實時狀態無法同步

---

### 3.4 payment-flow（資金池適配與付款管理）

**技術：** PHP Laravel 10，三個資料庫（payflow / jindin / ginbao）

**職責：**
- 金鼎（Jindin）資金跑分平台：提現/充值訂單管理、SMS/微信帳單配對、佣金管理
- 金寶（Ginbao）保證金管理：安全保證金、超額限制
- 資金池適配層（Cashpool）：銜接 paymentpool，處理充提配對回調
- 付款審批流程：多級審核（Payment 模組）
- 匯率拉取：火幣/歐易/幣安 API

**健康指標：**
- 各資金池通道可用性
- 審核隊列積壓狀況

**異常徵兆：**
- 提現無法出款 → 金鼎 TxWithdraw 狀態異常 或 cashpool 配對失敗
- 配對失敗 → pool 回調未送達 payment-flow，查 cashpool API 路由
- 匯率數據異常 → 三方交易所 API 失效

---

### 3.5 risk_api（風控系統）

**職責：**
- 充值/提款風險評估（在訂單建立時同步調用）
- 銀行卡真偽與風險評分
- 會員信用評分（ML 模型）
- 凍結機率計算

**健康指標：**
- API 回應時間（應 < 500ms，否則影響整體下單速度）
- 風控通過率（異常升降均需關注）
- Celery 異步任務積壓量

**異常徵兆：**
- risk_api 回應超時 → payment 訂單建立卡住
- 風控通過率異常下降 → 模型問題或規則誤觸
- Celery 積壓 → Worker 異常

---

## 4. 極速（Jisu）主流程與關鍵節點

### 充值流程

```
Step 1  infogen → payment        建立 Auction 充值訂單
Step 2  payment → risk_api       風控審查（同步，阻塞）
Step 3  payment → paymentpool    競拍選卡（同步，阻塞）
Step 4  payment → infogen        返回收款帳號資訊
Step 5  使用者轉帳後上傳收據
Step 6  infogen → payment        更新訂單（附收據圖片）
Step 7  payment → paymentpool    確認到帳，釋放卡
Step 8  WebSocket                推送完成通知
```

**關鍵阻塞節點：** Step 2（風控）& Step 3（選卡）是同步串行，任一超時均直接影響使用者體感。

### 提款流程

```
Step 1  infogen → payment        建立 Auction 提款訂單
Step 2  payment → risk_api       風控審查（同步）
Step 3  payment → paymentpool    選取付款卡
Step 4  payment-flow             路由至出款通道
Step 5  WebSocket                推送出款結果
```

---

## 5. 服務依賴關係（根因排查用）

```
問題現象                      優先排查方向
─────────────────────────────────────────────────────
充值訂單無法建立              paymentpool 可用卡數量 → risk_api 狀態
提款訂單卡住                  payment-flow 通道狀態 → risk_api 狀態
前端狀態不更新                WebSocket（Reverb/Echo Server）
訂單建立慢（>3s）             risk_api 回應時間 → Redis 連線
大量訂單「處理中」不完成       Horizon Queue 積壓 → payment-flow 回調
截圖上傳失敗                  七牛雲服務狀態
```

---

## 6. 技術堆疊總覽（供 MCP API 串接參考）

| 類別 | 技術 | 服務 |
|------|------|------|
| 語言/框架 | PHP 8.1-8.3 / Laravel 10-12 | infogen, payment, paymentpool, payment-flow |
| 語言/框架 | Python 3.8 / Flask | risk_api |
| 常駐模式 | Octane + Swoole | payment, paymentpool |
| 資料庫 | MariaDB / MySQL | 全服務（infogen 除外） |
| 快取/隊列 | Redis | 全服務 |
| 隊列監控 | Laravel Horizon | payment, paymentpool |
| 異步任務 | Celery | risk_api |
| WebSocket | Reverb（payment, infogen）/ Echo Server（paymentpool）| |
| 圖片儲存 | 七牛雲（Qiniu） | infogen |
| 日誌 | ELK（串接中） | 全服務 |

---

## 7. ELK 日誌查詢建議

> 詳細的關鍵字情境對照表請見：`elk-keywords.md`（從原始碼實際提取）
>
> ELK Index 對照：
> - paymentpool → `ph-ol-pool-cn*`（pre: `pre-pool-cn*`，beta: `beta-pool-cn*`）⚠️ 加 `*`，近期資料在日期分區 index
> - risk_api → `ph-ol-risk-api`（pre: `pre-risk-api`，beta: `beta-risk-api`）
> - channel → `ph-ol-channel-cn*`

常見問題快速關鍵字：

| 情境 | ELK 關鍵字 | Index |
|------|-----------|-------|
| 充值失敗、卡池無卡 | `ThirdPartyFilter 過濾後無可用卡片` | ph-ol-pool-cn* |
| 充值搶單失敗 | `充值單: %s 領單失敗` | ph-ol-pool-cn* |
| Channel 建單失敗 | `channel %s create recharge failed cause` | ph-ol-pool-cn* |
| 極速提現配對失敗 | `極速提現配對失敗轉提現先決` | ph-ol-channel-cn* |
| 卡片被鎖 | `已被鎖卡` | ph-ol-pool-cn* |
| 回調失敗（充值） | `發送充值結果通知給平台失敗` | ph-ol-channel-cn* |
| 回調失敗（提現） | `發送提現結果通知給平台失敗` | ph-ol-channel-cn* |
| 風控異常 | `取得風控資料失敗` | ph-ol-channel-cn* |
| 前端建單失敗 | `搶單充值建單請求失敗` | ph-ol-channel-cn* |
| 圖片辨識失敗 | `圖片辨識發生錯誤, 轉AI辨識` | ph-ol-channel-cn* |
| IM 通知異常 | `(im) 接收 IM 訊息異常` | ph-ol-channel-cn* |
| 匯率拉取失敗 | `火幣拉取資料失敗` OR `歐易拉取資料失敗` OR `幣安拉取資料失敗` | ph-ol-channel-cn* |

---

## 8. 給 openclaw 的問答參考

**Q: 現在系統有沒有問題？**
→ 依序檢查：① paymentpool 可用卡數 ② payment Horizon 隊列積壓 ③ risk_api 回應時間 ④ 近 5 分鐘訂單完成率

**Q: 為什麼使用者充值失敗？**
→ 查詢 payment 的 `auction create` 錯誤日誌，定位是風控拒絕、卡池無卡、還是 infogen→payment 通訊問題

**Q: 為什麼提款很慢？**
→ 查 payment-flow 通道回應時間 + Horizon 隊列積壓

**Q: 卡池夠不夠用？**
→ 直接查 paymentpool 可用卡數量（MCP API 串接後可直接查詢）

---

## 9. Openclaw 系統架構

```
┌──────────────────────────────────────────────────────────────────┐
│                        營運團隊（使用者）                           │
│              "現在系統有沒有問題？"  "這筆訂單為什麼失敗？"           │
└──────────────────────────────┬───────────────────────────────────┘
                               │ 自然語言
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                   Openclaw AI Agent                              │
│                (Claude claude-opus-4-6 / claude-sonnet-4-6)               │
│                                                                  │
│   System Prompt: OnePay 系統知識庫 + 工具使用說明                  │
└──────┬──────────────────────┬──────────────────────┬────────────┘
       │ MCP Protocol         │ MCP Protocol         │ MCP Protocol
       ▼                      ▼                      ▼
┌─────────────┐   ┌───────────────────────┐   ┌─────────────────┐
│ onepay-mcp  │   │      elk-mcp          │   │  (future)       │
│   server    │   │      server           │   │  alert-mcp      │
│             │   │                       │   │  server         │
│ • 健康狀態   │   │ • 全文日誌搜尋          │   │                 │
│ • 卡池查詢   │   │ • 錯誤日誌彙整          │   │ • 告警訂閱       │
│ • 訂單查詢   │   │ • 慢查詢分析            │   │ • 主動通知       │
│ • 隊列狀態   │   │ • Service log filter  │   │                 │
│ • 風控狀態   │   │                       │   │                 │
│ • 統計報表   │   │                       │   │                 │
└──────┬──────┘   └──────────┬────────────┘   └─────────────────┘
       │                     │
       │ HTTP / Internal      │ Elasticsearch API
       ▼                     ▼
┌──────────────────┐   ┌─────────────────────────────────────────┐
│  OnePay 各服務   │   │                 ELK Stack                │
│                  │   │  Elasticsearch + Logstash + Kibana       │
│  • payment       │   │                                         │
│  • paymentpool   │   │  Indices:                               │
│  • payment-flow  │   │  • {env}-channel-cn*  (channel/infogen/payment-flow)                     │
│  • risk_api      │   │  • {env}-pool-cn      (paymentpool)                 │
│  • infogen       │   │  • {env}-risk-api     (risk_api)                │
│                  │   │  • {env}-payment-cn   (payment)                        │
└──────────────────┘   └─────────────────────────────────────────┘
```

---

## 10. 各服務需新增的健康端點

為了讓 onepay-mcp 能正確查詢，建議在各服務新增以下內部 API：

| 服務 | 端點 | 回傳 |
|------|------|------|
| payment | `GET /internal/health` | Horizon 隊列深度、失敗 Job 數 |
| payment | `GET /internal/stats/hourly` | `CalAuctionHourly` 近 1/6/24 小時彙整 |
| paymentpool | `GET /internal/cards/summary` | 可用卡數、容量統計 |
| paymentpool | `GET /internal/stats/transactions` | 充提款成功率統計 |
| risk_api | `GET /internal/health` | 平均回應時間、通過率 |
| payment-flow | `GET /internal/channels/status` | 各通道可用性 |

---

## 11. Openclaw System Prompt 設計

```
你是 OnePay 的運維助理 Openclaw。OnePay 是一套以「極速（Auction）」為主要模式的支付系統，服務中國大陸市場。

【系統架構】
- infogen-micro-service：使用者的極速充值/提款前端入口
- payment：訂單中心，管理充提款訂單生命週期
- paymentpool：銀行卡池，透過競拍（Auction）分配收款卡
- payment-flow：支付通道路由
- risk_api：風控，使用 ML 模型評估交易風險

【極速流程】
充值：infogen → payment（建單）→ risk_api（風控）→ paymentpool（競拍選卡）→ 使用者匯款 → 確認完成
提款：infogen → payment（建單）→ risk_api（風控）→ paymentpool（選付款卡）→ payment-flow（路由出款）

【優先排查原則】
1. 充值訂單無法建立 → 先查 paymentpool 可用卡數量
2. 訂單建立慢 → 先查 risk_api 回應時間
3. 訂單卡在「處理中」→ 先查 Horizon 隊列積壓
4. 全面失敗 → 先查 detect_anomalies

【狀態碼對照】
充值狀態碼：0=等待, 1=處理中, 2=成功, 3=失敗, 5=超時, 12=等待配對（完整列表見 order-lifecycle.md）
提現狀態碼：0=初始, 1=處理中, 2=成功, 3=失敗, 5=超時, 13=等待配對（完整列表見 order-lifecycle.md）
AUCTION_MODE: 1=JFB, 2=Alipay, 3=WeChat

回答時請先給結論，再給細節。如果需要更多資料才能判斷，請主動呼叫工具查詢。
```

