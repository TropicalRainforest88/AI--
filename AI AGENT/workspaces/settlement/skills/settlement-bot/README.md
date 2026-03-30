# skill-settlement-bot

OpenClaw workspace skill — 結算訂單查詢與銀行回單 OCR 辨識 Telegram Bot。

## 功能

- **訂單查詢** — 支援 PAY 訂單號、WDR 提款單號、商戶訂單號、用戶 ID、帳號、姓名
- **銀行回單 OCR** — 圖片辨識付款人/收款人/金額/時間，自動查詢對應訂單
- **異常訂單過濾** — 非訂單號查詢自動過濾成功/失敗，只顯示異常
- **一鍵轉發** — 異常訂單附帶轉發按鈕，點擊即可轉發至 OP 群組
- **群組支援** — 支援群組 @mention 查詢，結果直接回覆群組

## 安裝

### 1. Clone 到 OpenClaw workspace 的 skills 目錄

```bash
cd ~/.openclaw/workspace-<your-agent>/skills/
git clone https://github.com/<your-repo>/skill-settlement-bot.git settlement-bot
```

### 2. 設定環境變數

```bash
# 在 workspace 根目錄建立 .env
cp skills/settlement-bot/.env.example ~/.openclaw/workspace-<your-agent>/.env
# 編輯 .env 填入實際值
```

### 3. 設定 SOUL.md

將 `SOUL.md` 複製到 workspace 根目錄，並將 `<WORKSPACE>` 替換為實際路徑：

```bash
cp skills/settlement-bot/SOUL.md ~/.openclaw/workspace-<your-agent>/SOUL.md
# 編輯 SOUL.md，將 <WORKSPACE> 替換為 ~/.openclaw/workspace-<your-agent>
```

### 4. 在 openclaw.json 註冊 agent

```json
{
  "id": "settlement",
  "name": "結算測試助理",
  "workspace": "~/.openclaw/workspace-settlement",
  "model": "openai/gpt-4.1"
}
```

## 專案結構

```
skill-settlement-bot/
├── SKILL.md              # OpenClaw skill 定義（agent 自動載入）
├── SOUL.md               # AI 助理行為規則（複製到 workspace 根目錄）
├── IDENTITY.md           # AI 身份設定
├── .env.example          # 環境變數範本
├── scripts/
│   ├── env.mjs           # 環境變數載入器
│   ├── es-query.mjs      # 訂單查詢主腳本
│   ├── es-detail.mjs     # 按鈕回調處理（查詳情/轉發）
│   └── tg-forward.mjs    # Telegram 群組轉發工具
└── README.md
```

## 技術架構

- **Runtime**: Node.js (ESM, 零外部依賴)
- **資料源**: Elasticsearch（`ph-ol-channel-cn-*` 索引）
- **通訊**: Telegram Bot API
- **AI 引擎**: OpenClaw + GPT-4.1（OCR、對話理解）

## 環境變數

| 變數 | 說明 |
|------|------|
| `TG_BOT_TOKEN` | Telegram Bot Token |
| `ES_HOST` | Elasticsearch 主機 |
| `ES_PORT` | Elasticsearch 端口（預設 9200）|
| `ES_USER` | Elasticsearch 使用者 |
| `ES_PASS` | Elasticsearch 密碼 |
| `TG_FORWARD_GROUP` | 異常訂單轉發的目標群組 ID |
