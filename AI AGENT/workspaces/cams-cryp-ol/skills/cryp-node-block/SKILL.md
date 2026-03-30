---
name: cryp-node-block
description: 當操作者提到 節點、node、RPC、failover、區塊高度停滯、所有節點disable、節點切換、cron panic 時觸發
metadata:
  openclaw:
    emoji: "🔗"
    requires:
      bins: ["mcporter"]
---

# CRYP 節點與區塊高度問題診斷

## MCP 伺服器
- 名稱: cams-mcp
- 工具: search_logs, search_by_trace, get_log_context, get_error_summary, get_log_trend, list_indices, get_version
- **所有指令加 `--output json`**

| 指令 | 用途 | 關鍵參數 |
|------|------|---------|
| search_logs | 搜尋日誌 | index, query, size, level, from_time, to_time |
| search_by_trace | 用 trace_id 追蹤 | index, trace_id |
| get_log_context | 取得日誌前後文 | index, log_id, before, after |
| get_error_summary | 錯誤統計 | index, field, from_time, to_time |
| get_log_trend | 日誌趨勢 | index, interval, from_time, to_time |

## 鏈別 Index 對照表

| Index | 鏈 |
|-------|-----|
| cryp-polygon | Polygon |
| cryp-bsc | BSC |
| cryp-eth | Ethereum |
| cryp-tron | TRON |
| cryp-sol-v2 | Solana |
| cryp-arbitrum | Arbitrum |
| cryp-optimism | Optimism |
| cryp-base | Base |
| cryp-avax-cchain | Avalanche |
| cryp-ton | TON |
| cryp-btc | Bitcoin |
| cryp-dot | Polkadot |
| cryp-sui | Sui |
| cryp-sonic | Sonic |
| cryp-kaspa | Kaspa |

> **重要**：每次查詢前必須先問操作者是哪條鏈，再使用對應的 `cryp-{chain.code}` index。

## 前置知識

- 每條鏈有獨立節點管理，RPC 端點不同但 Failover 機制相同
- Failover：最多 3 次重試，間隔 1s，退避倍率 1.5x
- 重試觸發關鍵字：`no such host`、`403`、`Not enough CU`、`504`、`503`、`429`、`502`、`401`
- 節點列表在 `json_config_V2` 表管理，支援動態切換
- 節點配置來源：
  - 啟動時：RabbitMQ Admin API (`GET {adminGuiURL}/v1/jsoncfg/list/node/cryp-{chain.code}`)
  - 運行時：MQ 推送（Exchange: `cryp.node` Direct 類型，binding key: `cryp-{chain.code}`）
  - Failover：回報至 Admin API (`PUT {adminGuiURL}/v1/jsoncfg/updateList`)
- 新/變更節點自動功能測試：getBlockByNumber, getBalance, getTransactionCount, gasPrice
- 所有 Cron 任務都有 panic recovery，下一分鐘自動重啟
- 所有節點 disable 時，系統使用 disabled 節點作為降級模式
- 常用搜尋欄位：`failover`、`use node`、`trouble node`、`cron panic`、`task_name`

## 診斷流程

### 情境一：節點 Failover 頻繁

收集：failover 日誌頻率和錯誤內容、當前使用節點

查 failover 日誌：
```
cams-mcp.search_logs --index cryp-{chain} --query "failover" --size 30 --output json
```

查當前使用節點：
```
cams-mcp.search_logs --index cryp-{chain} --query "use node" --size 5 --output json
```

查問題節點：
```
cams-mcp.search_logs --index cryp-{chain} --query "trouble node" --size 10 --output json
```

判斷方式：
- 只有特定節點 failover → 該節點異常，系統已自動切換，可在 RabbitMQ Admin 中 disable
- 所有節點都 failover → 網路問題 / 節點提供商異常 / 鏈擁堵

錯誤類型對照：

| 錯誤訊息 | 原因 |
|---------|------|
| 403 / 401 | API Key 失效或額度用完 |
| 429 Too Many Requests | 請求頻率超限，需升級方案 |
| 504 / 502 / 503 | 節點服務端問題，通常暫時性 |
| no such host | DNS 解析失敗，確認節點 URL |
| Not enough CU | Compute Unit 不足（如 Alchemy），需升級方案 |

### 情境二：所有節點 Disable

- **請 RD 查詢 DB**：查 `json_config_V2` 表中各節點啟用/停用狀態
- 所有節點都 disable → 緊急狀態，系統會嘗試使用 disabled 節點（降級模式）
  - 需在 RabbitMQ Admin 新增可用節點，或修復現有節點後重新啟用
  - 新節點自動進行功能測試（getBlockByNumber, getBalance, getTransactionCount, gasPrice），通過才啟用
- 部分節點 disable → 系統使用仍啟用的節點，disable 節點因測試失敗被停用

### 情境三：節點配置更新問題

收集：RabbitMQ 連線狀態、配置更新日誌

- 啟動時未載入 → 確認 RabbitMQ Admin API 可達性，查日誌：
  ```
  cams-mcp.search_logs --index cryp-{chain} --query "init rabbitmq failed" --level error --output json
  ```
- 運行時未收到更新 → 確認 MQ 消費者狀態（Exchange: `cryp.node`，binding key: `cryp-{chain.code}`），連線失敗每分鐘重試
- Failover 後未回報 → 查回報是否成功：
  ```
  cams-mcp.search_logs --index cryp-{chain} --query "updateList" --output json
  ```

### 情境四：Cron Panic

查 panic 日誌：
```
cams-mcp.search_logs --index cryp-{chain} --query "cron panic" --level error --output json
```

| 任務 | 影響 |
|-----|------|
| ListenBlock | 刷塊停滯，區塊高度不更新 |
| RunWithdraw | 佇列提幣延遲 |
| TransactionConfirm | notify_status 不會更新 |
| TransactionNotify | 商戶通知延遲 |

所有排程任務都有 panic recovery，下一分鐘自動重啟。查 `error_type` 確認根因，若反覆 panic 需排查（通常是節點回傳異常資料）。
