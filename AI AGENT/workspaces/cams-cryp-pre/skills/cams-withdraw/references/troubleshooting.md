# 提現 (Withdraw) 排查

## 狀態流轉

```
商戶 API 請求 → Pending → [審核?] → CreateTransfer → TransferCreated → PreTransfer → ProcessTransfer → Confirming → Success/Failed → 通知商戶
                                                                          ↑                    |
                                                                          └── WaitRetryTransfer ←┘ (失敗重試)
```

## 常見問題

### 提現卡住未處理

1. 用 OrderID (WD) 查 ELK，確認目前狀態
2. 若停在 Pending → 檢查 RabbitMQ `withdraw.create_transfer` 是否正常消費
3. 若停在 CreateTransfer → 檢查 Transfer 建立 log
4. 若停在 ProcessTransfer → 檢查 cryp 執行狀態

### 提現失敗

1. 用 OrderID 查 ELK，找到失敗原因
2. 確認 RetryCount 是否已達商戶設定的 WithdrawRetryCount 上限
3. 若未達上限 → 應自動重試，查重試 log
4. 確認提現錢包餘額是否足夠

### 提現錢包餘額不足

1. 查提現錢包 (withdraw 類型) 的餘額
2. 確認下發排程是否正常運作（每 2 分鐘）
3. 確認歸集錢包是否有足夠資金可下發

### 提現通知商戶失敗

1. 用 OrderID 查 notify 相關 log
2. 確認 NotifyStatus 與 NotifyCount
3. 確認商戶的 NotifyWithdrawURL 是否正確
