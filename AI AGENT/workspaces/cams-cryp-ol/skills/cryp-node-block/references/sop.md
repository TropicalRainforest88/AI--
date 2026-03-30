# 節點與區塊高度問題處理

> **相關 Spec 參考**
> - [05-integrations.md](../specs/05-integrations.md) - 節點 Failover 機制與動態配置
> - [00-overview.md](../specs/00-overview.md) - 系統架構與排程任務
> - [troubleshooting/03-notify-alert.md](../specs/troubleshooting/03-notify-alert.md) - 節點相關告警

> **多鏈架構說明**
> cryp 是多鏈架構，每條鏈有獨立的節點管理（RPC 端點不同，但 Failover 機制相同）。以下以 ETH 為範例說明，其他鏈的節點功能測試項目可能不同。

> **ELK 查詢指引**
> - ELK Index：`cryp-{chain.code}`（如 `cryp-eth`、`cryp-tron`、`cryp-bsc`）
> - 需先確認是哪條鏈，再查對應的 index
> - 常用搜尋欄位：`failover`、`use node`、`trouble node`、`cron panic`、`task_name`

## 適用情境

節點故障、Failover 頻繁、所有節點 Disable、區塊高度停滯、節點切換問題。

---

## 情境一：節點 Failover 頻繁

### 排查步驟

1. **查 ELK 日誌**
   - 關鍵字：`failover error`、`failover retry`、`節點切換`
   - 短時間大量 failover 表示所有節點不穩定

2. **確認觸發 failover 的錯誤**
   - `no such host`、`403 Forbidden`、`504 Gateway Timeout`、`429 Too Many Requests`、`502 Bad Gateway` 等

3. **確認 Failover 機制**
   - 最多重試 3 次，間隔 1 秒，退避係數 1.5
   - 重試時自動切換至其他可用節點

---

## 情境二：所有節點 Disable

### 排查步驟

1. **查日誌**
   - `節點功能測試失敗, 已自動disable此節點`

2. **確認節點列表**
   - 查 `json_config_V2` 表中的節點狀態

3. **緊急處理**
   - 所有節點 disable 時，系統會嘗試使用 disable 的節點
   - 需在 RabbitMQ Admin 中新增或修復節點

4. **節點功能測試項目**
   - `eth_getBlockByNumber`
   - `eth_getBalance`
   - `eth_getTransactionCount`
   - `eth_gasPrice`

---

## 情境三：節點動態配置更新

### 更新來源

| 來源 | 時機 |
|------|------|
| RabbitMQ Admin API | 啟動時查詢 `GET /v1/jsoncfg/list/node/cryp-{chain.code}` |
| RabbitMQ 消費者 | 運行時接收即時推送 |
| Failover 回報 | 節點切換後 `PUT /v1/jsoncfg/updateList` |

### 排查步驟

1. **確認 RabbitMQ 連線**
   - 查日誌 `init rabbitmq failed`
   - 連線失敗時每分鐘重試

2. **確認消費者**
   - Exchange: `cryp.node`（Direct 類型）
   - Queue 綁定 key: `cryp-{chain.code}`（如 `cryp-eth`）

---

## 情境四：Cron Panic

### 排查步驟

1. **查日誌**
   - 關鍵字：`cron panic`
   - 包含 `error_type`、`job_name`

2. **影響範圍**
   - Panic 後該任務停止，下一分鐘重新啟動
   - 所有排程任務都有 panic recovery

3. **常見 panic 任務**
   - ListenBlock、RunWithdraw、TransactionConfirm 等
