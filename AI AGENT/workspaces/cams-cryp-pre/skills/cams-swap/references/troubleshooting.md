# 兌換 (Swap) 排查

## 狀態流轉

```
商戶 API 請求 → Pending → CreateTransfer → 建立 swap_from + swap_to → 執行鏈上兌換 → cryp 分別回調 → 兩筆都完成 → Success → 通知商戶
```

## 常見問題

### 兌換卡住

1. 用 OrderID (SW) 查 ELK
2. Swap 有兩筆 Transfer（swap_from + swap_to），需分別查狀態
3. 若 swap_from 完成但 swap_to 未完成 → 查 swap_to 的 cryp 回調
4. 兩筆都完成才算訂單成功

### 兌換滑點失敗

1. 查 ELK 中的 ActualRate 與 Rate 的偏差
2. 比對商戶的 SwapSlippage 設定
3. 若偏差超過滑點 → 交易被拒絕是正常行為

### 兌換通知商戶失敗

1. 用 OrderID 查 notify 相關 log
2. 確認商戶的 NotifySwapURL 是否正確
