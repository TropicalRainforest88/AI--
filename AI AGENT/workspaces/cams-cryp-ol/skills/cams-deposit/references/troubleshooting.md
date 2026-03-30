# 充值 (Deposit) 排查

## 狀態流轉

```
cryp 回調 → Transaction 建立 → Deposit 訂單建立 → Transfer 建立 → 風險檢查 → 成功 → 通知商戶 → 觸發歸集評估
```

## 常見問題

### 充值沒入帳

1. 用 TxHash 或 ToAddress 查 ELK，確認是否有收到 cryp 回調
2. 若無回調 → 問題在 cryp 端或鏈上交易尚未確認
3. 若有回調 → 查 deposit 建立流程 log，看卡在哪個狀態
4. 檢查是否低於 MinDepositAmount 被忽略

### 充值被標記風險地址

1. 用 OrderID (DE) 查 ELK
2. 查 Transfer 狀態是否為 `StatusTRRiskAddress`
3. 確認風險來源（TronScan / OKX）

### 充值通知商戶失敗

1. 用 OrderID 查 notify 相關 log
2. 確認 NotifyStatus 與 NotifyCount
3. 確認商戶的 NotifyDepositURL 是否正確
