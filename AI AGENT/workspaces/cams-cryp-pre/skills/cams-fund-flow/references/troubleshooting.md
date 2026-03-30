# 資金流轉（歸集/下發）排查

## 歸集 (Collection)

### 流程
```
用戶錢包 (user) ──[collection]──→ 歸集錢包 (collection)
```

### 歸集未觸發
1. 確認用戶錢包餘額是否超過 UserWalletLimit
2. 確認歸集排程是否正常（每 3 分鐘）
3. 查 ELK 中 `wallet.collection` queue 的消費 log

### 歸集失敗
1. 查歸集 Transfer（類型 `collection`）的狀態
2. 若手續費不足 → 查 supplement_fee Transfer 是否成功
3. 歸集狀態：待確認(1) → 手續費補充中(2) → 歸集處理中(4) → 成功/失敗

## 下發 (Distribution)

### 流程
```
歸集錢包 (collection) ──[distribute]──→ 提現錢包 (withdraw)
```

### 下發未觸發
1. 確認提現錢包餘額是否低於所需水位
2. 確認下發排程是否正常（每 2 分鐘）
3. 查 ELK 中 `wallet.distribution` queue 的消費 log

### 下發失敗
1. 查下發 Transfer（類型 `distribute`）的狀態
2. 確認歸集錢包是否有足夠資金
