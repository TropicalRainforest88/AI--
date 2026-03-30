# 錢包轉帳 (WalletTransfer) 排查

## 狀態流轉

```
後台發起 → AuditPending → AuditPass → CreateTransfer → 執行 → Success
                        → AuditReject → 餘額回滾
                        → AuditTimeout (2hr) → 餘額回滾
```

## 常見問題

### 錢包轉帳審核超時

1. 用 OrderID (WT) 查 ELK
2. 確認 AuditStatus 是否為超時 (4)
3. 審核超時時限為 2 小時，由排程任務每 10 分鐘檢查

### 錢包轉帳被否決

1. 查 AuditReason 了解否決原因
2. 確認否決後餘額是否已自動回滾

### 角色轉帳限額

1. 確認操作者角色的 DailyTransferLimit
2. admin 角色免除 USDT 限額
