# 流動池 (LiquidityPool) 排查

## 狀態流轉

```
商戶 API 請求 → Pending → CreateTransfer → 建立 liquidity_add/remove Transfer → 執行鏈上操作 → cryp 回調 → Success/Failed → 通知商戶
```

## 常見問題

### 流動池操作失敗

1. 用 OrderID (LP) 查 ELK
2. 確認 Action 類型（add / remove）
3. 確認 Version（v2 / v3），不同版本處理邏輯不同
4. 查對應 Transfer（liquidity_add 或 liquidity_remove）的狀態

### 流動池滑點失敗

1. 查 ELK 中實際金額與預期金額的偏差
2. 比對商戶的 LiquidityPoolSlippage 設定

### 流動池通知商戶失敗

1. 用 OrderID 查 notify 相關 log
2. 確認商戶的 NotifyLiquidityPoolURL 是否正確
