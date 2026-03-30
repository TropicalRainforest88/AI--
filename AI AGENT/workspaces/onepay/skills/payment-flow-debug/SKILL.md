---
name: payment-flow-debug
description: 當用戶反映 Telegram Bot 沒有回應、金寶安全押金 Bot 異常、/產能報表 沒反應時觸發
---

# Payment-Flow Telegram Bot 排查 SOP

## 基本資訊

| 項目 | 值 |
|------|-----|
| Bot 名稱 | 產能BOT / GBSDOLbot |
| Bot ID | 7940775785 |
| Bot Username | @GBSDOLbot |
| ELK Index | `ol-rrr-YYYY.MM.DD`（依日期換，如 `ol-rrr-2026.03.22`）|
| ELK 帳密 | 見 `docs/elk-keywords.md`（含 ELK 連線資訊）|
| 輪詢機制 | Laravel getUpdates，每 3 秒自我重派 |

---

## 第一步：區分「Bot 異常」vs「Telegram 投遞問題」

這是最重要的判斷，兩者根本不同。

### 快速判斷法

查 ELK，看 Bot **同一時段**有沒有回應**其他群組或私聊**：

```json
{
  "query": { "query_string": { "query": "接收 Telegram 訊息" } },
  "filter": { "range": { "datetime": { "gte": "故障開始時間", "lt": "故障結束時間" } } }
}
```

| 結果 | 判斷 |
|------|------|
| 有回應其他群組/私聊 | **Telegram 投遞問題**（Bot 正常，特定群組靜默）|
| 完全沒有任何回應 | **Bot 本身異常**（queue 掛了、服務掛了）|

---

## 情境 A：Telegram 投遞問題（Bot 正常但特定群組沒反應）

**症狀：** 用戶說某群組發指令沒反應，但其他地方 Bot 可以用。

### 排查步驟

**Step 1：確認最後一次成功投遞的時間點**

```json
{
  "query": { "query_string": { "query": "resp_content:*{target_chat_id}*" } },
  "sort": [{ "datetime": { "order": "desc" } }],
  "size": 5
}
```

找到最後一筆的 `datetime` 和 `update_id`。

**Step 2：確認故障期間 Bot 是否有收到任何該群組訊息**

```json
{
  "query": { "query_string": { "query": "resp_content:*{target_chat_id}*" } },
  "filter": { "range": { "datetime": { "gte": "最後成功時間", "lt": "恢復時間" } } }
}
```

**如果零結果** → 確認 Telegram 完全停止向 Bot 投遞該群組訊息。

**Step 3：查是否有 my_chat_member 事件（踢出/加入/限制）**

```json
{
  "query": { "query_string": { "query": "resp_content:*my_chat_member* AND resp_content:*{target_chat_id}*" } }
}
```

解讀 `_source.resp_content` 中的 `my_chat_member`：
- `old_status: "member"` → `new_status: "left"`：Bot 被踢出
- `old_status: "left"` → `new_status: "member"`：Bot 被重新加入
- `old_status: "member"` → `new_status: "restricted"`：Bot 被限制

**Step 4：交叉確認 Bot 代碼正常**

```json
{
  "query": { "query_string": { "query": "resp_content:*update_id* NOT resp_content:*{target_chat_id}*" } },
  "filter": { "range": { "datetime": { "gte": "故障期間" } } }
}
```

有結果 → Bot 正常運作，問題在 Telegram 投遞層。

### 根因結論模板

```
根因：Telegram 端停止向 GBSDOLbot 投遞 {群組名稱}（{chat_id}）的訊息。
最後成功投遞：{時間}（update_id={N}）
恢復時間：{時間}（update_id={N}）
靜默期間：約 {X} 小時
Bot 代碼：全程正常（同期有處理其他群組/私聊訊息）
觸發事件：{有/無} my_chat_member 事件（{描述}）
```

### 處理方式

1. **踢出 Bot 後重新加入**是標準修復手段
2. ⚠️ 重加後 Telegram 後端**不一定立即恢復**，實測案例需等約 2-3 小時
3. 如果重加後短時間未恢復，告知用戶繼續等待，不需要再操作
4. 恢復後確認 ELK 出現新的 `resp_content:*{chat_id}*` 記錄

---

## 情境 B：Bot 本身異常（完全沒有回應）

**症狀：** Bot 對所有群組和私聊都無反應。

### 可能原因

1. **Laravel queue worker 掛了**：`TelegramSecurityDepositGetUpdatesJob` 停止輪詢
2. **WithoutOverlapping lock 卡住**：lock key 60s 後自動過期，通常自行恢復
3. **getUpdates API 錯誤**：Telegram API token 問題或網路問題
4. **Cache 問題**：offset key `security-deposit-telegram-handled-update-id` 損壞

### 排查步驟

**Step 1：確認 getUpdates 是否還在輪詢**

```json
{
  "query": { "query_string": { "query": "message:\"external request\"" } },
  "filter": { "range": { "datetime": { "gte": "now-10m" } } },
  "size": 20
}
```

每 3-4 秒一筆 → 輪詢正常；中斷 → queue worker 問題。

**Step 2：查是否有 Telegram API 錯誤**

```json
{
  "query": { "query_string": { "query": "level:error OR \"400\" OR \"403\" OR \"Unauthorized\"" } },
  "filter": { "range": { "datetime": { "gte": "故障前後30分鐘" } } }
}
```

**Step 3：確認 queue 狀態**

需請 RD 確認 Laravel queue worker 是否在跑：
```bash
php artisan queue:work --queue=telegram-security-deposit
```

---

## ELK 欄位說明

payment-flow 的 ELK (`ol-rrr-*`) 欄位：

| 欄位 | 說明 |
|------|------|
| `datetime` | 日誌時間（Asia/Shanghai = UTC+8）|
| `message` | 主要日誌訊息，如 `接收 Telegram 訊息`、`external request` |
| `level` | 日誌等級（INFO / ERROR / WARNING）|
| `resp_content` | HTTP 回應內容，getUpdates 的完整 JSON 在這裡 |

### ⚠️ 關鍵注意：Telegram Update 在 resp_content

Bot 收到的所有 Telegram update（訊息、my_chat_member、callback_query 等）**都在 `resp_content` 欄位**，不在 `message` 欄位。

- 搜群組訊息：`resp_content:*{chat_id}*`
- 搜特定 update_id：`resp_content:*{update_id}*`
- 搜事件類型：`resp_content:*my_chat_member*`

**空 resp_content = getUpdates 輪詢有跑但沒收到訊息（`result: []`）**

---

## 實際案例：2026-03-22 GBSDOLbot 停止回應事件

**現象：** 群組 `-1002030031984`（GB[内部]业务群）10:35 後 `/產能報表` 無反應，持續至 22:15。

**排查結論：**
- Bot getUpdates 全程正常輪詢（ELK 有持續 `external request` 日誌）
- 同時段 Bot 可正常回應私聊（update_id=269410376）和其他群組（update_id=269410379）
- 目標群組在 10:34 → 22:15 之間 **零投遞**（ELK 完全查不到 resp_content 含該 chat_id）
- 19:27 踢出重加後，Telegram 仍延遲約 **2h45m** 才恢復投遞
- 根因：**Telegram 後端針對該群組的訊息路由中斷**，非代碼問題

**教訓：**
- 踢出重加是對的，但要告知可能需要等 2-3 小時
- Bot 停止回應**第一個動作是查 ELK 確認是否還有其他群組的活動**，而不是重啟服務
