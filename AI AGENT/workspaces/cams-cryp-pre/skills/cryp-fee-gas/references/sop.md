# 手續費與 Gas 問題處理

> **相關 Spec 參考**
> - [04-fee.md](../specs/04-fee.md) - 手續費計算公式、統計排程、Gas 參數
> - [03-withdraw-flow.md](../specs/03-withdraw-flow.md) - 提幣時手續費估算

> **多鏈架構說明**
> cryp 是多鏈架構，手續費機制依鏈而異：EVM 鏈使用 gas_price × gas_limit；TRON 使用 Energy + Bandwidth；其他鏈各有不同模型。以下以 EVM 鏈為範例說明。

> **ELK 查詢指引**
> - ELK Index：`cryp-{chain.code}`（如 `cryp-eth`、`cryp-tron`、`cryp-bsc`）
> - 需先確認是哪條鏈，不同鏈的 Gas 機制差異大

## 適用情境

手續費查詢結果異常、Gas 參數不合理、提幣因 Gas 問題失敗。

---

## 情境一：手續費查詢結果異常

### 排查步驟

1. **確認手續費計算公式**
   ```
   fee = tokens.gas_price × tokens.gas_limit × 10^(-18)
   ```
   - 結果使用 RoundBank(8) 四捨六入五取偶到小數 8 位

2. **查詢 tokens 表**
   ```sql
   SELECT crypto_type, gas_limit, gas_price, transaction_fee FROM tokens WHERE crypto_type = '幣種';
   ```

3. **確認統計排程是否正常**
   - 主幣：StatisticsNativeFee
   - 代幣：StatisticsTokenFee

---

## 情境二：Gas 參數不合理

### 排查步驟

1. **主幣 Gas 統計邏輯**
   - 取 blockHeight - confirmCount/2 高度的成功主幣交易
   - 計算平均 gas_limit 和 gas_price
   - 更新 tokens 表

2. **代幣 Gas 統計邏輯**
   - 取得各合約地址的 Transfer 事件 log
   - 每個代幣隨機取最多 5 筆交易
   - 計算平均 gas_limit、gas_price
   - EIP-1559 交易：gas_price = baseFee + gasTipCap

3. **檢查 gas_limit_min**
   - tokens 表有 `gas_limit_min` 手動下限設定

---

## 情境三：提幣因 Gas 問題失敗

### 排查步驟

1. **Gas Price 過低**
   - 交易可能被節點拒絕或長時間 pending
   - 查 tokens 表的 gas_price 與當前鏈上 gas price 比較

2. **Gas Limit 不足（代幣）**
   - 代幣提幣後若實際 gas > token.gas_limit，系統會背景更新 gas_limit
   - 查日誌確認是否有 gas limit 更新記錄

3. **EIP-1559 相關**
   - 實際手續費：`receipt.gas_used × receipt.effective_gas_price`
   - EffectiveGasPrice 可能與提交時不同

---

## 初始 Gas 參數參考

| 參數 | 值 |
|------|------|
| 初始 gas_price | 33 Gwei (migration 000002) |
| 配置預設 gas_price | 1 Gwei |
| ETH decimals | 18 |
