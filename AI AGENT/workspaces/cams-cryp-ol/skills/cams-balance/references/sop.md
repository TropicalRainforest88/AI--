# 錢包餘額與資金管理

> **相關 Spec 參考**
> - [01-glossary.md](../specs/01-glossary.md) - 五種錢包類型、TokenWallet、HoldingAmount/Cost 定義
> - [04-billing.md](../specs/04-billing.md) - 代幣限額設定、成本追蹤、資產快照、對帳機制
> - [05-users-permissions.md](../specs/05-users-permissions.md) - wallet 模組權限（query、details、secret_key、transfer）
> - [06-integrations.md](../specs/06-integrations.md) - 價格同步排程、資產快照排程

> **ELK 查詢指引**
> - **cams-job**：餘額快照（SnapWalletAsset）、餘額刷新、成本計算等排程日誌
> - **cams-api**：手動轉入/轉出操作、錢包設定變更等 API 請求日誌
> - 常用搜尋欄位：`wallet_id`、`wallet_address`、`holding_amount`

## 適用情境

錢包餘額異常、資金對帳不平、錢包類型與限額管理、手動錢包操作。

## 錢包類型總覽

| 類型 | 代碼 | 用途 | 資金流向 |
|------|------|------|----------|
| 用戶錢包 | user | 接收用戶充值 | 充值入 → 歸集出 |
| 商戶錢包 | merchant | 商戶級別資金管理 | 管理用 |
| 提現錢包 | withdraw | 執行提現出款 | 下發入 → 提現出 |
| 歸集錢包 | collection | 資金歸集中繼 | 歸集入 → 下發出 |
| 外轉錢包 | external | 外部轉帳 | 特殊用途 |

---

## 情境一：錢包帳面餘額與鏈上不一致

### 觸發條件

淨資產差異告警觸發，或對帳報表顯示差異。

### 診斷步驟

1. **取得兩邊數據**
   - 帳面：TokenWallet.HoldingAmount
   - 鏈上：透過後台「餘額刷新」功能取得實際鏈上餘額

2. **計算差異**
   - 差異 = 鏈上餘額 - 帳面餘額
   - 正差異：鏈上多（可能有未入帳的交易）
   - 負差異：帳面多（可能有未記錄的轉出）

3. **排查差異來源**

| 差異方向 | 可能原因 | 排查方式 |
|----------|----------|----------|
| 鏈上多 | 未入帳的充值交易 | 查是否有遺漏的 cryp 回調 |
| 鏈上多 | 外部直接轉入（非系統管理） | 查鏈上交易歷史 |
| 帳面多 | Transfer 成功但鏈上實際失敗 | 查 TxHash 確認鏈上狀態 |
| 帳面多 | 帳面更新但轉帳未完成 | 查最近的 Transfer 狀態 |

4. **修正方式**
   - 若有遺漏的交易 → 手動建立 `manual_in` 或 `manual_out` Transfer 調帳
   - 使用後台餘額刷新功能同步鏈上餘額
   - 確認每日快照 (SnapWalletAsset, 每日 00:30) 是否正常

---

## 情境二：代幣限額設定不當

### 觸發條件

歸集/下發頻率異常（太頻繁或太少），或單筆轉帳被限額拒絕。

### 診斷步驟

1. **查詢當前限額設定**

| 限額欄位 | 影響範圍 |
|----------|----------|
| UserWalletLimit | 用戶錢包儲存上限，超過觸發歸集 |
| CollectWalletLimit | 歸集錢包儲存上限 |
| WithdrawWalletLimit | 提現錢包儲存上限 |
| UserWalletTransferLimit | 用戶錢包單筆轉帳上限 |
| CollectWalletTransferLimit | 歸集錢包單筆轉帳上限 |
| WithdrawWalletTransferLimit | 提現錢包單筆轉帳上限 |
| MinDepositAmount | 最小充值金額 |

2. **評估與調整**

| 問題 | 可能原因 | 調整建議 |
|------|----------|----------|
| 歸集太頻繁 | UserWalletLimit 設定太低 | 適當提高 UserWalletLimit |
| 歸集不觸發 | UserWalletLimit 設定太高 | 降低 UserWalletLimit |
| 下發金額不足 | WithdrawWalletTransferLimit 太低 | 提高限額 |
| 大額轉帳被拒 | 對應 TransferLimit 太低 | 根據業務需求調整 |

---

## 情境三：錢包成本與損益異常

### 觸發條件

錢包損益報表數據異常，成本計算不正確。

### 診斷步驟

1. **查詢成本數據**
   - TokenWallet.HoldingCost：持有成本
   - TokenWallet.HoldingAvgCost：平均成本
   - TokenWallet.CurrentInAmount：當前轉入量
   - TokenWallet.CurrentOutAmount：當前轉出量

2. **確認 UnitPrice 來源**
   - 每筆 Transfer 記錄 `UnitPrice`（取自 trading_pair.price）
   - 確認 TradingPair 價格是否正常同步
   - 價格來源：Binance / MEXC / FameEx / Cams 內部

3. **排查價格同步**
   - 排程：每 10 分鐘 (SyncPrice)
   - 查 ELK 確認排程執行正常
   - 比對系統價格與交易所實際價格

---

## 情境四：手動錢包操作

### 人工轉入/轉出 (manual_in / manual_out)

**使用場景**：帳面調整、修正差異、特殊資金操作

- Transfer 類型：`manual_in`（人工轉入）、`manual_out`（人工轉出）
- 這類 Transfer 不對應任何業務訂單
- 用於修正帳面與鏈上的差異

### 錢包類型變更

**使用場景**：調整錢包用途

- 透過後台「錢包詳情」功能變更錢包類型
- 需要 `wallet > details > update` 權限
- 變更後會影響資金流轉邏輯

### 批次操作與匯出

- 支援批次刷新餘額
- 支援匯出錢包資料
- 支援私鑰匯出（需要 `wallet > secret_key > read` 權限，操作會記錄）
