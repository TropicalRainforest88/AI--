---
name: cryp-fee-gas
description: 當操作者提到 手續費、fee、gas、gas price、gas limit、手續費異常、Gas過高、Gas過低、transaction_fee 時觸發
metadata:
  openclaw:
    emoji: "⛽"
    requires:
      bins: ["mcporter"]
---

# CRYP 手續費與 Gas 問題診斷

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

> **重要**：每次查詢前必須先問操作者是哪條鏈，不同鏈的 Gas 機制差異極大。

## 前置知識

- 手續費機制依鏈而異：
  - **EVM 鏈**（ETH、BSC、Polygon 等）：`fee = gas_used x gas_price`（wei → ETH: / 10^18）
  - **EIP-1559**（ETH 等）：`gas_price = baseFee + gasTipCap`
  - **TRON**：Energy + Bandwidth 機制
  - 其他鏈各有不同模型
- API 查詢手續費（EVM）：`fee = tokens.gas_price x tokens.gas_limit x 10^(-18)`，RoundBank(8)
- Gas 統計排程：
  - **StatisticsNativeFee**：取主幣（如 ETH）成功交易計算平均 gas_limit 和 gas_price
  - **StatisticsTokenFee**：各代幣隨機取最多 5 筆交易計算平均值
  - 統計在 ListenBlock 流程中觸發
- gas_limit 自動更新：代幣提幣時若實際 gas > 當前 token.gas_limit，系統會背景更新
- 初始值：33 Gwei（migration），配置預設 1 Gwei

## 診斷流程

### 情境一：手續費查詢結果異常

收集：幣種(crypto_type)、API 回傳手續費值、預期合理範圍

- **請 RD 查詢 DB**：`SELECT crypto_type, gas_limit, gas_price, transaction_fee FROM tokens WHERE crypto_type = '幣種';`

判斷方式：

**gas_price 過高**
- Gas 統計排程可能抓到異常高的鏈上交易
- 統計邏輯：取區塊中的交易計算平均值
- 鏈上 gas 暴漲若是暫時的，下次統計自動修正
- 緊急情況可 **請 RD 手動執行** 更新 tokens 表 gas_price

**gas_price 過低**
- 可能導致提幣交易長時間 pending 或被節點拒絕
- 初始值：33 Gwei（migration），配置預設 1 Gwei
- 與當前鏈上 gas price 比較，必要時 **請 RD 手動執行** 調整

**gas_limit 不合理**
- gas_limit 由統計排程更新，代幣提幣時實際 gas > 當前值也會自動更新
- 可查 gas_limit_min（手動設定下限）是否合理

**transaction_fee 與計算不符**
- `transaction_fee = gas_price x gas_limit / 10^18`，RoundBank(8)
- 可能是統計排程更新了部分欄位，手動重新計算確認

**所有參數正常但手續費仍不合理**
- 查節點建議的 gas price：可透過 `eth_gasPrice` RPC 查詢
- 鏈上 gas 與系統差距大，可能是統計排程未及時更新

### 情境二：提幣因 Gas 問題失敗

收集：transfer_id 或 tx_hash、錯誤訊息

查提幣 Gas 相關錯誤：
```
cams-mcp.search_logs --index cryp-{chain} --query "run withdraw error" --level error --output json
```

也可用 tx_hash 追蹤：
```
cams-mcp.search_logs --index cryp-{chain} --query "tx_hash:{hash}" --output json
```

| 失敗原因 | 處理方式 |
|---------|---------|
| 節點拒絕（gas price 太低） | tokens.gas_price 低於節點最低要求，**請 RD 查詢 DB** 確認並更新 |
| pending 過久 | gas price 低於市場價，可等待/用相同 nonce+更高 gas price 替代/更新 tokens.gas_price |
| Out of gas | gas_limit 不足，**請 RD 手動執行** 調高 tokens.gas_limit 後重試 |
| EIP-1559 差異 | 實際手續費 = receipt.gas_used x receipt.effective_gas_price，可能與提交時不同 |

### 情境三：Gas 統計排程問題

收集：最近 Gas 統計 log、tokens 表 gas 參數更新時間

查統計排程日誌：
```
cams-mcp.search_logs --index cryp-{chain} --query "StatisticsFee OR StatisticsNativeFee OR StatisticsTokenFee" --output json
```

**主幣統計（StatisticsNativeFee）邏輯**：
1. 取 blockHeight - confirmCount/2 高度的成功主幣交易
2. 計算所有交易的平均 gas_limit 和 gas_price
3. 更新 tokens 表
4. 若無符合條件的交易，可能不會更新

**代幣統計（StatisticsTokenFee）邏輯**：
1. 取各合約地址的 Transfer 事件 log
2. 每個代幣隨機取最多 5 筆交易
3. 對每筆取 receipt + 原始交易計算 gas_price
4. EIP-1559 交易：gas_price = baseFee + gasTipCap
5. 計算平均值更新 tokens 表

**統計未執行**：
- StatisticsFee 在 ListenBlock 流程中觸發
- 若 ListenBlock 排程異常，Gas 統計也會停止
- 先確認 ListenBlock 狀態，參考 cryp-deposit skill 情境五
