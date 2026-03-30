---
name: cryp-specs
description: "Use when needing cryp system specifications, DB schema, transaction flow details, withdraw flow, fee calculations, or external integrations. Keywords: cryp系統規格、DB schema、交易流程、提幣流程、手續費計算、外部串接"
metadata:
  openclaw:
    emoji: "📖"
    requires:
      bins: ["mcporter"]
---

# cryp-eth 系統規格參考

## 1. 系統總覽

cryp-eth 是 Ethereum (ETH) 鏈的加密貨幣充提幣服務，負責監聽鏈上區塊、偵測充值交易、執行提幣操作，並將交易結果通知給上游商戶系統。

### 服務對象

- 上游商戶系統（透過 API 呼叫充提幣功能）
- 內部管理系統（透過 RabbitMQ Admin GUI 管理節點配置）

### 核心業務目標

1. **充值偵測**：持續監聽 ETH 鏈區塊，自動偵測系統管理地址的入帳交易（ETH 主幣 + ERC-20 代幣）
2. **提幣執行**：接收商戶提幣請求，簽署並廣播交易至鏈上
3. **交易確認**：追蹤交易上鏈狀態，確認後通知商戶
4. **手續費統計**：根據鏈上交易動態統計 gas 費用

### 技術棧

| 項目 | 技術 |
|------|------|
| 語言 | Go 1.23 |
| Web 框架 | Gin |
| ORM | GORM |
| 資料庫 | MySQL (db_cryp_eth) |
| 排程 | robfig/cron |
| 訊息佇列 | RabbitMQ |
| 區塊鏈 SDK | go-ethereum + 內部 chain-sdk |
| 監控 | Elasticsearch (ELK) + Pyroscope |
| 精度處理 | shopspring/decimal |

### 系統架構

系統分為兩個獨立執行程序：

#### API Server (`cmd/api/main.go`)

提供 RESTful API 給商戶系統呼叫：
- 地址管理（建立 / 新增 / 查餘額）
- 代幣管理（建立 / 查詢 / 更新）
- 提幣請求（同步 / 非同步）
- 手續費查詢
- 區塊高度查詢
- 交易查詢
- 健康檢查 / 版本資訊

#### Cron Worker (`cmd/cron/main.go`)

背景排程，每分鐘執行以下任務：

| 排程任務 | 說明 |
|----------|------|
| `ListenBlock` | 監聽新區塊，抓取充值 / 提幣交易 |
| `RetrySyncTxnByFailBlockNum` | 重試失敗區塊的交易抓取 |
| `TransactionConfirm` | 確認待確認交易是否已上鏈成功 |
| `RunWithdraw` | 處理佇列中的非同步提幣請求 |
| `CheckWithdraw` | 檢查提幣交易是否已上鏈 |
| `TransactionNotify` | 向商戶發送交易通知 |

### 模組間關聯

```
商戶系統 ──HTTP──▶ API Server ──▶ usecase (address/token/withdraw/fee/transaction)
                                       │
                                       ▼
                                   Repository ──▶ MySQL (db_cryp_eth)
                                       │
                                       ▼
                                   ethclient ──▶ ETH Node (RPC/WSS)

Cron Worker ──▶ usecase/cron/chain ──▶ ethclient (刷塊/確認)
            ──▶ usecase/cron/notify ──▶ merchant notify (HTTP callback)
            ──▶ usecase/withdraw    ──▶ keychain (取私鑰) + ethclient (簽署廣播)

RabbitMQ ──消費──▶ jsonConfigV2 ──▶ 節點切換 (動態更新 ethclient RPC 端點)
```

### 專案目錄結構

```
cryp-eth/
├── api/                    # API 層（路由 + 控制器）
├── cmd/                    # 程式進入點（api / cron）
├── cron/                   # 排程任務註冊與啟動
├── internal/
│   ├── model/              # 資料庫模型（GORM）
│   ├── pkg/                # 內部套件
│   │   ├── jsonConfigV2/   # 節點動態配置管理
│   │   ├── nodeclient/     # ETH 節點客戶端初始化 + failover
│   │   ├── rabbitmq/       # RabbitMQ 消費者
│   │   ├── taskmgr/        # 排程任務鎖管理
│   │   └── utils/          # 工具函式
│   ├── repository/         # 資料存取層（GORM 查詢）
│   └── usecase/            # 業務邏輯層
│       ├── address/        # 地址業務
│       ├── cron/chain/     # 區塊監聽 + 交易確認 + 提幣執行
│       ├── cron/notify/    # 交易 / 風控 / 提幣通知
│       ├── fee/            # 手續費查詢
│       ├── token/          # 代幣管理
│       ├── transaction/    # 交易抓取與同步
│       └── withdraw/       # 提幣簽署與廣播
├── setting/                # 配置與資料庫初始化
└── static/                 # 靜態資源（Dockerfile、SQL、配置檔）
```

---

## 2. 術語表

| 英文名 | 中文名 | 定義 |
|--------|--------|------|
| Chain Type | 鏈類型 | 區塊鏈網路類型，本系統固定為 `ETH` |
| Crypto Type | 幣種類型 | 如 `ETH`（主幣）、`USDT`、`USDC` 等（ERC-20） |
| Native Coin | 主幣 / 原生幣 | 鏈的原生貨幣，ETH 鏈即為 `ETH` |
| Token | 代幣 | ERC-20 標準的智能合約代幣 |
| Merchant Type | 商戶類型 | 整數值，區分不同上游商戶，決定通知 URL 和地址歸屬 |
| Deposit | 充值 / 入金 | 外部地址轉帳至系統管理地址，tx_type = 1 |
| Withdraw | 提幣 / 提現 | 系統管理地址轉帳至外部地址，tx_type = 2 |
| Block Height | 區塊高度 | 當前系統追蹤到的區塊編號 |
| Confirm Count | 確認數 | 交易需等待的區塊確認數（dev=12, local=32） |
| Nonce | 交易序號 | 以太坊帳戶的交易計數器，每筆遞增，防止重放攻擊 |
| Gas | 燃料 | 以太坊交易所需的計算資源單位 |
| Gas Limit | 燃料限制 | 交易願意消耗的最大 gas |
| Gas Price | 燃料價格 | 每單位 gas 的價格（單位：wei） |
| Gas Used | 實際燃料消耗 | 從 receipt 取得 |
| Fee | 手續費 | gas_used x gas_price（單位：ETH） |
| Fee Crypto | 手續費幣種 | ETH 鏈固定為 `ETH` |
| Transaction Fee | 交易手續費 | tokens 表中統計的平均手續費 |
| Tx Hash | 交易雜湊 | 鏈上交易唯一識別碼（66 字元十六進位） |
| Tx Hash Origin | 原始交易雜湊 | 提幣重試時記錄原本的 tx_hash |
| Transfer ID | 交易識別碼 | 商戶端自訂的 UUID，用於非同步提幣冪等性 |
| Tx ID | 交易 ID | 提幣重試時傳入的原始 tx_hash |
| Contract Address | 合約地址 | ERC-20 代幣的智能合約地址 |
| Contract ABI | 合約介面描述 | 智能合約的 ABI JSON |
| Decimals | 精度位數 | 幣種小數精度（ETH = 18） |
| Signed Transaction | 簽署交易 | 經私鑰簽署的交易物件 |
| Pending Transaction | 待確認交易 | 已廣播但尚未被打包進區塊 |
| Block Retry | 區塊重試 | 抓取失敗的區塊加入重試佇列 |
| Failover | 故障轉移 | RPC 節點錯誤時自動切換 |
| Task Manager | 任務管理器 | 排程任務鎖，防重複執行 |
| Notify Status | 通知狀態 | 0=未處理, 1=待通知, 2=成功, 3=失敗, 4=無需通知 |
| Risk Control Status | 風控狀態 | 值域同 Notify Status |
| Has Chain | 是否上鏈 | 0=未上鏈, 1=已上鏈 |
| Has Retried | 是否已重試 | 0=未重試, 1=已重試 |
| Withdraw Status | 提幣狀態 | 0=處理中, 1=成功, 2=失敗 |
| Json Config V2 | 動態節點配置 | 透過 RabbitMQ 動態更新的 RPC 節點配置 |
| Keychain | 金鑰保管庫 | 外部服務，管理各地址私鑰 |
| Merchant Notify | 商戶通知 | HTTP callback 通知交易結果 |

---

## 3. 交易流程

### 交易類型

| tx_type | 名稱 | 說明 |
|---------|------|------|
| 1 | Deposit（充值） | 外部地址 → 系統管理地址 |
| 2 | Withdraw（提幣） | 系統管理地址 → 外部地址 |

**判斷邏輯**（`transaction/minor.go:GetTxType`）：
- `from_address` 在 `address` 表 → Withdraw
- `to_address` 在 `address` 表 → Deposit
- 都不在 → 非系統交易，略過

### 交易狀態 (transaction.status)

| 值 | 常量 | 說明 |
|----|------|------|
| 0 | TxStatusWaitConfirm | 待確認（已偵測但未達確認數） |
| 1 | TxStatusSuccess | 鏈上交易成功 |
| 2 | TxStatusFail | 鏈上交易失敗 |

### 通知狀態 (transaction.notify_status)

| 值 | 說明 |
|----|------|
| 0 | 未處理（Unprocessed） |
| 1 | 待通知（Pending） |
| 2 | 通知成功 |
| 3 | 通知失敗 |
| 4 | 無需通知 |

### 風控狀態 (transaction.risk_control_status)

值域同通知狀態。交易已成功或失敗時，直接標記為成功（不需風控通知）。

### 充值交易生命週期

```
鏈上交易發生（外部地址轉入系統地址）
  → Cron ListenBlock 偵測到 → WaitConfirm (status=0)
  → Cron TransactionConfirm
    → receipt.status=1 → Success (status=1)
    → receipt.status=0 → Fail (status=2)
  → 更新 notify_status=1（待通知）
  → Cron TransactionNotify
    → 通知成功 (notify_status=2)
    → 通知失敗 (notify_status=3)
```

### 提幣交易生命週期

```
API CreateWithdrawByTransferId → 寫入 withdraw 表 (status=0)
  → Cron RunWithdraw → 取得私鑰（Keychain RSA）
    → 簽署廣播成功 → status=1, 通知商戶（等確認）
    → 簽署廣播失敗 → status=2, 通知商戶（失敗）
  → Cron ListenBlock 偵測到鏈上交易
  → Cron TransactionConfirm
  → Cron TransactionNotify → 通知商戶
```

### 核心流程詳解

#### 1. 區塊監聽 (ListenBlock)

1. 從 `block_height` 表取得當前追蹤高度
2. 從 ETH 節點取得最新區塊高度
3. 計算差距（需扣除 confirmCount）
4. 每次最多處理 6 個區塊（`maxProcessBlockNum`）
5. 對每個區塊：取得區塊 → 抓取交易（`FetchTxns`）→ 同步寫入 DB（`SyncTxns`）→ 更新 `block_height`
6. 差距小於 6 個區塊時等待 10 秒再繼續
7. Watchdog：60 秒內 DB 區塊高度未增加則取消 context

#### 2. 交易抓取 (FetchTxns)

**主幣交易 (FetchNativeTxns)**：
- 遍歷區塊中所有交易
- 過濾：`tx.To != nil`、`tx.Value > 0`、`chainId` 匹配
- 取得 sender，檢查 from/to 是否為系統地址
- 建立 Transaction 記錄（status=WaitConfirm）

**代幣交易 (FetchTokenTxns)**：
- 從 `tokens` 表取得所有合約地址
- 呼叫 `ethclient.GetTransactionByToken` 取得 Transfer 事件 log
- 過濾 `LogTransferSigHash` / `LogERC20TransferSigHash`
- 排除 ERC-721（topics > 3）
- 解析金額，建立 Transaction 記錄

#### 3. 交易同步 (SyncTxns)

1. 提幣交易：比對 `withdraw` 表（by from_address + nonce + amount）
2. 若鏈上 tx_hash 與 withdraw 不同，記錄 `tx_hash_origin`
3. 批量寫入 `transaction` 表
4. 更新 `block_height`（僅當 upflag=true）
5. 更新 withdraw 的 `has_chain=1`

#### 4. 交易確認 (TransactionConfirm)

1. 最新區塊高度 - confirmCount = 確認線
2. 查詢 `status=0 AND block_height <= 確認線`（每次最多 20 筆）
3. 呼叫 `ethclient.GetTransactionReceipt`
4. 根據 receipt.Status 更新成功/失敗
5. 更新 gas_used、gas_price、fee、notify_status=Pending

#### 5. 交易通知 (TransactionNotify)

1. 查詢 `notify_status=Pending` 的交易
2. Deposit → 從 `to_address` 查 merchant_type → 取通知 URL
3. Withdraw → 從 `from_address` 查 merchant_type → 取通知 URL
4. 查詢 withdraw 表取得 transfer_id
5. 發送 HTTP callback，更新 notify_status

#### 6. 區塊重試 (RetrySyncTxnByFailBlockNum)

- `blockretry` 模組管理失敗區塊佇列
- 重試時不更新 block_height（upflag=false）

---

## 4. 提幣流程

### 提幣方式

| 方式 | 狀態 | 說明 |
|------|------|------|
| 同步提幣 | **已棄用** | 直接在 API 請求中簽署廣播，需攜帶 SecretKey |
| 非同步提幣 | **目前使用** | 寫入 withdraw 表後由 Cron 背景處理 |

### 非同步提幣完整流程

```
API POST /withdraw
  → 驗證 transfer_id（有效 UUID）
  → 驗證地址（IsValidAddress）
  → 檢查冪等（GetWithdrawByTransferID）
  → 寫入 DB (status=0)
  → 回傳 TransferID

Cron RunWithdraw（每分鐘）
  → 取得私鑰（Keychain RSA 加密傳輸）
  → processingWithdraw
    → 成功：status=1, 通知商戶
    → 失敗：status=2, 通知商戶
```

### 提幣處理核心邏輯 (processingWithdraw)

1. **取得代幣資訊**：從 `tokens` 表查詢 gas 參數和合約資訊
2. **驗證餘額**：`ethclient.GetBalance`（主幣）或 `GetTokenBalance`（代幣），不足回 `ErrBalanceInsufficient`
3. **取得 Nonce**：`SELECT ... FOR UPDATE` 鎖定地址 → `PendingNonceAt` → 比較鏈上/DB nonce 取較大值
4. **簽署交易**：主幣用 `MakeSignTxn`，代幣用 `MakeSignTxnByToken`
5. **廣播交易**：`SendTransaction`，支援 nonce 重試
6. **記錄結果**：重試提幣時更新原 withdraw（`has_retried=1, status=2`）

### 提幣狀態 (withdraw.status)

| 值 | 說明 |
|----|------|
| 0 | 處理中（佇列中，等待 Cron 執行） |
| 1 | 成功（已廣播至鏈上） |
| 2 | 失敗（簽署或廣播失敗） |

### 上鏈狀態 (withdraw.has_chain)

| 值 | 說明 |
|----|------|
| 0 | 未上鏈（交易可能在 mempool 或遺失） |
| 1 | 已上鏈（Cron 確認交易已進入區塊） |

### 重試狀態 (withdraw.has_retried)

| 值 | 說明 |
|----|------|
| 0 | 未重試 |
| 1 | 已重試（原交易被標記為失敗） |

### 提幣檢查 (CheckWithdraw)

每分鐘 Cron 執行，檢查近 7 天 `has_chain=0 AND has_retried=0` 的記錄：

1. 跳過建立不到 5 分鐘的記錄
2. 呼叫 `ethclient.IsPendingTx` 檢查：
   - **仍在 pending**：不處理
   - **已上鏈（not pending）**：更新 `has_chain=1`
   - **找不到交易（NotFound）**：發送重試通知，更新 `has_retried=1, status=2`

---

## 5. Nonce 管理策略

Nonce 是提幣的關鍵，錯誤的 nonce 會導致交易失敗或卡住。

### 新提幣 Nonce 取得 (newNonce)

1. 從鏈上取得 `PendingNonceAt`（chainNonce）
2. 從 `withdraw` 表取得最大成功 nonce（withdrawNonce）
3. `nonceLatest = max(withdrawNonce+1, chainNonce)`

### 重試提幣 Nonce 取得 (retryNonce)

1. 檢查原交易是否仍 pending
2. 不在 pending → `ErrTransactionOnChain`（不需重試）
3. 仍在 pending → 從鏈上取得 `PendingNonceAt`

### Nonce 錯誤自動修正

- `nonce too low`：從錯誤訊息正則提取正確 nonce 或從 DB 取得，自動重試一次
- `already known`：同上處理
- 重試成功後更新 `address.nonce`

---

## 6. 手續費計算

### 基本公式

```
fee = gas_used x gas_price（wei → ETH，即 / 10^18）
```

### 手續費查詢 API (GetFee)

```
fee = tokens.gas_price x tokens.gas_limit x 10^(-18)
```

結果 `RoundBank(8)` 四捨六入五取偶到小數 8 位。

### 手續費統計排程

#### 主幣手續費統計 (StatisticsNativeFee)

1. 取得 `blockHeight - confirmCount/2` 高度的成功主幣交易
2. 計算平均 gas_limit 和平均 gas_price
3. 平均 fee = `avg_gas_limit x avg_gas_price / 10^18`，取 8 位小數
4. 更新 `tokens` 表中主幣（ETH）的 gas_limit、gas_price、transaction_fee

#### 代幣手續費統計 (StatisticsTokenFee)

1. 取得所有合約地址
2. 從區塊取得代幣 Transfer 事件 log
3. 過濾系統支援的合約、金額 > 0
4. 每個代幣隨機取最多 5 筆交易
5. 取得 receipt + 原始交易
6. 計算 gas_price：
   - Legacy/AccessList 交易：直接 `tx.GasPrice()`
   - DynamicFee (EIP-1559)：`baseFee + gasTipCap`
7. 計算平均 gas_limit、gas_price
8. fee = `avg_gas_limit x avg_gas_price / 10^18`
9. 更新 `tokens` 表

### 提幣時手續費

- 簽署時：`ethclient.GetEstimateTxFee` 根據 tokens 的 gas_price 和 gas_limit 計算
- 確認後：`actual_fee = receipt.gas_used x receipt.effective_gas_price`（以 receipt 為準）

### tokens 表手續費欄位

| 欄位 | 說明 | 更新時機 |
|------|------|----------|
| `gas_limit` | 預估 gas 用量 | 統計排程；代幣提幣時若實際 gas > 當前值也更新 |
| `gas_price` | 預估 gas 單價（wei） | 統計排程 |
| `transaction_fee` | 預估手續費（ETH） | 統計排程 |
| `gas_limit_min` | Gas 消耗下限 | 手動設定 |

### 初始 Gas 參數

- 初始 gas_price：`33000000000`（33 Gwei，migration 000002 統一更新）
- ETH 主幣 decimals：18
- 配置預設 gas_price：`1000000000`（1 Gwei）

---

## 7. 外部系統串接

### 1. Ethereum 節點 (RPC)

**連線**：支援 HTTPS/WSS，配置在 `config.yaml` 的 `node.rpc`，支援多節點 + 動態切換

**主要呼叫方法**：

| 方法 | 說明 | 使用場景 |
|------|------|----------|
| `eth_getBlockByNumber` | 取得指定區塊 | 刷塊（ListenBlock） |
| `eth_getTransactionReceipt` | 取得交易回執 | 交易確認 |
| `eth_getBalance` | 取得地址餘額 | 餘額查詢 / 提幣前驗證 |
| `eth_getTransactionCount` | 取得 Pending Nonce | 提幣 Nonce |
| `eth_sendRawTransaction` | 廣播簽署交易 | 提幣 |
| `eth_gasPrice` | 取得建議 Gas Price | 手續費估算 |
| `eth_getLogs` | 取得合約事件日誌 | 代幣交易抓取 |
| `eth_getTransactionByHash` | 取得交易資訊 | 手續費統計 / 交易查詢 |

**Failover 機制**：
- 最多重試 3 次，間隔 1 秒，退避係數 1.5
- 觸發關鍵字：`no such host`、`403 Forbidden`、`Not enough CU`、`504 Gateway Timeout`、`Timeout`、`503`、`Service Unavailable`、`429 Too Many Requests`、`502 Bad Gateway`、`401 Unauthorized`
- 自動切換至其他可用節點
- 切換後回報 jsonConfigV2 至 Admin API

**節點動態配置**（`json_config_V2`）：
1. **啟動時**：從 RabbitMQ Admin GUI API 取得
2. **運行時**：透過 RabbitMQ 消費者即時推送
3. **Failover 時**：切換後回報 Admin API

新節點功能測試：`eth_getBlockByNumber`、`eth_getBalance`、`eth_getTransactionCount`、`eth_gasPrice`。失敗自動 disable。

### 2. RabbitMQ

接收節點配置更新推送。

```yaml
rabbitmq:
  url: amqp://guest:guest@127.0.0.1:5672
  adminGuiURL: http://localhost:8080
  exchange: cryp.node
```

- 交換機類型：Direct
- Queue 綁定 key：`cryp-eth`（server name）
- 訊息格式：`[]*model.JsonConfigV2` JSON 陣列
- 收到訊息後更新本地 `NodeManager.NodeList`
- 連線失敗時每分鐘重試

Admin API：
- 啟動時查詢：`GET {adminGuiURL}/v1/jsoncfg/list/node/cryp-eth`
- 節點變更回報：`PUT {adminGuiURL}/v1/jsoncfg/updateList`

### 3. Keychain 服務

安全管理各地址的私鑰，提幣時透過 RSA 加密傳輸。

**呼叫流程**：
1. cryp-eth 生成 RSA key pair
2. 將 public key + merchant_type + transfer_id 傳給 Keychain
3. Keychain 用 public key 加密私鑰後回傳
4. cryp-eth 用 private key 解密得到明文私鑰
5. 私鑰不落地、不寫 DB、不寫 log

### 4. 商戶通知 (Merchant Notify)

| 類型 | 觸發時機 | 通知內容 |
|------|----------|----------|
| TransactionNotify | 交易確認後 | 充值/提幣完整交易資訊 |
| RiskControlNotify | 風控待處理交易 | 交易資訊（含風控狀態） |
| WithdrawNotify | 非同步提幣完成後 | 提幣結果（成功/失敗） |
| CheckWithdraw Notify | 提幣交易鏈上遺失 | 重試通知（TxStatusRetryWithdraw） |

**通知 URL 決定**：根據 `merchant_type`，Deposit 用 `to_address`，Withdraw 用 `from_address`。

**通知內容欄位（TransactionNotify）**：

| 欄位 | 說明 |
|------|------|
| chain_type | 鏈類型（ETH） |
| crypto_type | 幣種類型 |
| tx_type | 1=充值, 2=提幣 |
| tx_hash_origin | 原始 tx_hash（重試時） |
| tx_hash | 鏈上交易雜湊 |
| block_height | 區塊高度 |
| from_address / to_address | 來源/目標地址 |
| amount | 金額 |
| fee / fee_crypto | 手續費 / 手續費幣種 |
| status | 交易狀態 |
| transaction_time | 鏈上時間 |
| transfer_id | 商戶交易識別碼 |

### 5. Elasticsearch (ELK)

```yaml
elastic:
  enable: true
  index: "cryp-eth"
  urls:
    - http://10.99.113.154:9200
```

使用 `zerolog` + `trace.TraceID` 串接全鏈路日誌。

### 6. Pyroscope

持續效能分析（Continuous Profiling）。

```yaml
pyroscope:
  enable: true
  appName: "cryp-eth"
  url: "http://10.99.113.154:4040"
```

### 7. MySQL

- 資料庫名稱：`db_cryp_eth`
- 驅動：MySQL + GORM
- 連線池：MaxIdle=10, MaxOpen=30, MaxLifetime=10m

---

## 8. 資料庫表

| 表名 | 用途 |
|------|------|
| `address` | 系統管理的鏈上地址（含 merchant_type、nonce） |
| `tokens` | 支援的加密貨幣資訊（合約地址、精度、gas 參數） |
| `block_height` | 當前追蹤的區塊高度 |
| `transaction` | 鏈上交易記錄（充值 + 提幣，含通知狀態） |
| `withdraw` | 提幣請求記錄（含非同步狀態、上鏈狀態） |
| `json_config_V2` | 節點動態配置（RPC URL、啟用狀態） |
| `third_party_api` | 第三方 API 配置 |
| `json_config` | 舊版可變動設定（已棄用） |

---

## 9. 排程任務一覽

| 任務 | 週期 | 超時設定 | 依賴外部系統 |
|------|------|----------|-------------|
| ListenBlock | @every 1m | 無超時（context.WithCancel） | ETH Node, MySQL |
| RetrySyncTxnByFailBlockNum | @every 1m | 無超時 | ETH Node, MySQL |
| TransactionConfirm | @every 1m | 120s (4x30s) | ETH Node, MySQL |
| RunWithdraw | @every 1m | 無超時 | ETH Node, Keychain, MySQL |
| CheckWithdraw | @every 1m | 120s (4x30s) | ETH Node, Merchant, MySQL |
| TransactionNotify | @every 1m | 120s (4x30s) | Merchant, MySQL |

---

## 10. 錯誤處理

| 錯誤 | 處理方式 |
|------|----------|
| `ErrBalanceInsufficient` | 直接回傳餘額不足 |
| `ErrCryptoNotFound` | 幣種不存在 |
| `ErrTransactionDuplicate` | 交易已存在（nonce 重複） |
| `ErrTransactionOnChain` | 交易已上鏈，不需重試 |
| `ErrorTransferAmountExceedsBalance` | 轉帳金額超過餘額 |
| `nonce too low` | 自動重試一次，取正確 nonce |
| `already known` | 同 nonce too low 處理 |
