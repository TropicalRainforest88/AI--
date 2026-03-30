---
name: settlement-bot
description: 結算訂單查詢與轉發工具。用於查詢 Elasticsearch 中的訂單狀態、轉發異常訂單到 Telegram 群組。當使用者提供訂單號、用戶ID、付款姓名、帳號或金額時使用。
metadata:
  {
    "openclaw": {
      "emoji": "🧮",
      "requires": { "bins": ["node"] }
    }
  }
---

# 結算訂單查詢與轉發

## 何時使用

✅ **使用此技能當：**
- 使用者提供訂單號（如 PAY00065...）、用戶ID（如 6082232）、付款姓名、帳號（如 b1534006@as）或金額
- 使用者詢問訂單狀態
- 使用者傳送銀行回單圖片（OCR 辨識後查詢）
- 使用者點擊了 inline button（callback_data 含 fwd: 或 PAY 開頭）

❌ **不使用此技能當：**
- 使用者只是在聊天、打招呼
- 與訂單查詢無關的問題

## 工具

**重要：所有查詢必須使用下面提供的 node 腳本，禁止使用 curl 或其他方式查詢。**

### 1. 訂單查詢 (es-query)

一般查詢用。腳本會直接透過 Telegram API 發送結果（含轉發按鈕）給用戶。

```bash
node ~/.openclaw/workspace-settlement/skills/settlement-bot/scripts/es-query.mjs "<keyword>" "<chat_id>"
```

2 個參數，不要加任何其他 flag：
- `<keyword>` — 查詢關鍵字
- `<chat_id>` — 回覆目標（見下方 chat_id 取得方式）

### 2. 訂單操作 (es-detail)

按鈕回調用。處理用戶點擊按鈕後的操作（查看詳情或轉發）。

```bash
node ~/.openclaw/workspace-settlement/skills/settlement-bot/scripts/es-detail.mjs "<callback_data>" "<chat_id>"
```

2 個參數：
- `<callback_data>` — 按鈕的 callback_data（如 `fwd:PAY000...` 或 `PAY000...`）
- `<chat_id>` — 回覆目標（見下方 chat_id 取得方式）

### 3. 圖片 OCR 辨識 (ocr-vision)

收到圖片時使用。**在獨立 process 中做 Gemini Vision 分析，只回傳文字結論。不要自己讀取圖片內容。**

```bash
node ~/.openclaw/workspace-settlement/skills/settlement-bot/scripts/ocr-vision.mjs "<image_path_or_url>"
```

1 個參數：
- `<image_path_or_url>` — 本地檔案路徑（從 `[media attached: /path/to/file.jpg]` 提取）或遠端 URL

輸出：JSON 格式的辨識結果，包含 receive_name、pay_name、pay_account、amount、transfer_time 等欄位。

**⚠️ 收到圖片時的完整處理流程：**
1. 從訊息中的 `[media attached: <path>]` 提取檔案路徑
2. 呼叫 ocr-vision.mjs，傳入檔案路徑
3. 用 JSON 結果格式化「📋 回單辨識結果」回覆用戶（見 SOUL.md）
4. 接著用辨識結果呼叫 es-query.mjs 查詢訂單

### chat_id 取得方式

- **私訊**（`is_group_chat` 不存在或為 false）→ 用 `sender_id`
- **群組**（`is_group_chat` 為 true）→ 從 `conversation_label` 提取群組 ID（如 `模擬市場客服回報測試 id:-5219909945` → `-5219909945`）

## ⚠️ 最重要的規則 ⚠️

**腳本的 stdout 輸出就是你的回覆。直接原封不動複製貼上，一個字都不能改。**

- 不要摘要
- 不要重新排版
- 不要加開頭語或結尾語
- 腳本輸出什麼，你就回覆什麼

## 如何判斷用哪個腳本

- `fwd:` 開頭 → es-detail.mjs（轉發按鈕）
- `PAY` 開頭長字串（30+ 字元）→ es-detail.mjs（查看詳情按鈕）
- 其他（帳號、姓名、用戶ID 等）→ es-query.mjs（一般查詢）

## 多行輸入處理

只取第一行作為查詢關鍵字。去除常見指令詞如「查詢訂單」「查詢」「幫我查」等。
