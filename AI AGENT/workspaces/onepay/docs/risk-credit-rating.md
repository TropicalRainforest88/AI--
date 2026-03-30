# Risk API 信用評級邏輯（/credit_rating V2）

> 框架：Flask + Flask-RESTful
> 版本：V2（新版評級系統）

---

## API 端點 & 環境

> ⚠️ 以下以 **ol（正式）** 為例，其他環境替換域名

```
POST http://risk.1-pay.co/credit_rating
```

## 請求範例

```json
{
  "member_code": "JS3B_XC",
  "userid": 2940397,
  "transfer_type": 1,
  "amount": 1000,
  "pay_real_user_name": "李成柱",
  "pay_real_bankcard_number": "",
  "ip": "139.214.10.89",
  "username": "hanshenghua123",
  "merchant_order": "PAY0005452026031419391900022820",
  "RealName": "李成柱",
  "ext_index": {
    "userid": 2940397,
    "userip": "139.214.10.89",
    "username": "hanshenghua123",
    "regddate": "2020-04-15 14:21:25",
    "depositcnt": "33",
    "depositsum": "34000.0000",
    "depositcnt2": "56",
    "depositsum2": "56500.0000",
    "depositcnt3": "89",
    "depositsum3": "83000.0000",
    "agent": "helloy5>1437360509>hanshenghua123",
    "deviceid": "Nu0zMahWAQFcdTagvVob",
    "balance": "0.4000",
    "profitsum": 277073.45,
    "withdrawsum": "22000.0000"
  }
}
```

## 響應範例

```json
{
  "message": "一般用戶進線",
  "member_code": "JS3B_XC",
  "userid": "2940397",
  "level": 3,
  "trig_downgrade": "N",
  "diff_name": {},
  "returncode": "01"
}
```

## returncode 說明

`returncode` 由 `CustomResponse` middleware 統一注入（`v2/app/custom_response.py`），非業務邏輯產生：

| HTTP status | returncode | 說明 |
|-------------|------------|------|
| 200 | `01` | 正常（SUCCESS） |
| 400 / 405 | `04` | 輸入格式錯誤（WRONG_INPUT） |
| 500 | `06` | 系統異常（EXCEPTION），message 強制改為 `API Exception` |

## 所有 message 類型（從源碼確認）

| message | 說明 | level |
|---------|------|-------|
| `白名單用戶進線(...)` | 白名單觸發（user_id/IP/姓名/卡號/username） | 白名單設定值（可為 -1, 0） |
| `白名單用戶進線(代理線)` | 代理線白名單（第二階段） | 13 |
| `大額交易用戶進線` | 白名單用戶但觸發大額交易開關 | blacklv |
| `特殊髒款屏蔽` | RISK-206 特殊髒款規則觸發 | -5 |
| `黑名單用戶進線(...)` | 黑名單觸發 | blacklv（通常 -5） |
| `觸發刷單屏蔽策略(ID)` | 空單屏蔽策略觸發 | -5 |
| `一般用戶進線` | 正常評級 | LV0~LVn |
| `輸入資料格式錯誤` | HTTP 400，參數格式錯誤 | 0 |
| `API Exception` | HTTP 500，系統異常（middleware 強制覆寫） | defaultlv |

**trig_downgrade**：`Y` = 觸發降等保護（rating_level > level，但保護機制恢復）

## 版本切換

- 開關 `new_version_credit_rating` 控制新舊版邏輯
- 舊版（`credit_rating.py`）：較簡單，無 trig_downgrade / diff_name / special_dirty 等機制
- 新版（`v2/app/js/credit_rating/credit_rating.py`）：完整邏輯（見下方）

---

## API 概述

**端點**: `POST /credit_rating`
**主要功能**: 用戶信用評級 + 風控判斷（機器學習多層級評分）

---

## 輸入參數

| 參數 | 說明 | 必填 |
|------|------|------|
| `member_code` | 商戶代碼 | ✓ |
| `userid` | 用戶ID（max 60） | ✓ |
| `transfer_type` | 1=充值, 2=提現 | ✓ |
| `amount` | 交易金額 | ✓ |
| `pay_real_user_name` | 銀行卡戶名（去 emoji/空格） | ✓ |
| `pay_real_bankcard_number` | 銀行卡號 | - |
| `ip` | IP 地址 | - |
| `username` | 用戶名 | - |
| `merchant_order` | 商戶訂單號 | - |
| `ext_index` | 擴展參數（JSON格式） | ✓ |

**ext_index 欄位**：`depositcnt2/sum2`（近期充提次數/金額）、`depositcnt3/sum3`、`regddate`、`deviceid`、`username`、`agent`（代理線，`>` 分隔）

---

## 判斷步驟（優先級順序）

### 優先級總覽

1. **白名單（第一階段）** - 最高優先級，不含 agent
2. **特殊髒款屏蔽（RISK-206）**
3. **黑名單**
4. **白名單（第二階段）** - 僅 agent LV13
5. **一般用戶評級計算**

---

### 第一步：資料驗證 & 商戶查詢

驗證參數格式 → 查商戶 → 取 `platform_name`

---

### 第二步：評級參數載入

優先級：**Agent 特定參數 > 商戶專屬參數 > Global 全局參數（按商戶 type）**

關鍵配置：
- `parameters`：評級計算參數
- `allow_short_whitelist`：白名單刷單容許值
- `special_dirty_bolck_rule`：特殊髒款屏蔽規則

---

### 第三步：用戶資料處理

1. 查詢或創建用戶（userid + member_id 為 key）
2. 取得**關聯用戶列表**（同平台 + 同 userid 或 username）
3. 更新所有關聯用戶資料（username, name, account, regddate, agent, 關聯姓名/卡號）
4. 若進線用戶無 real_name，嘗試從關聯用戶同步

---

### 第四步：評級數據來源

```python
IF member_switch.rating_data_from_db == True:
    從 DB 重新計算 depositcnt2/depositsum2
ELSE:
    使用 ext_index 傳入的數據
```

---

### 第五步：白名單檢查（第一階段）

查詢項目：user_id（關聯）、username、IP、name、card_number、deviceid、agent（僅 LV13）

**觸發時：**
- user_id/username → 取該等級
- 其他 → 取最低等級
- 若有 `member_specific` → 僅限該 member_id
- **刷單檢查（RISK-185）**：等級 IN [0, -1] 時，若 `depositcnt - deposit_success > allow_short_whitelist['LV'+level]` → level = -5

---

### 第六步：特殊髒款屏蔽（RISK-206）

**開關**：`special_dirty_bolck_rule['switch'] == 'ON'`

```python
is_special_dirty = (
    amount >= 設定金額 AND
    depositcnt3 <= 設定次數 AND
    depositsum3 <= 設定總額
)
```

觸發後：level = -5，同時在 `time_range` 小時內查找「相同 IP/deviceid + 不同 username」→ 自動拉黑（user_id, username, IP, deviceid），重試 3 次間隔 100ms

---

### 第七步：黑名單檢查

查詢項目：user_id（關聯）、IP、username、name、card_number、deviceid、agent（代理線分割）、blurred_name（模糊匹配）

觸發 → level = -5（若有 `member_specific` 則限指定 member）

---

### 第八步：白名單檢查（第二階段，僅 agent）

```python
IF agent 在白名單 AND level == 13:
    返回 level = 13
```

---

### 第九步：一般用戶評級計算

#### 9.1 歷史評級記錄 & 計算 rating_level

```python
# 基礎等級，按充值筆數(depositcnt)遞增
rating_level = LV0, LV1, LV2...

# 若距上次評級 >= rating_interval 天，且平均每 N 天未增加 1 筆：
rating_level = 計算(increase_count)  # 用增加筆數而非總筆數
```

#### 9.2 空單屏蔽策略（同步）

```python
IF 今日成功充值 == 0 AND 今日訂單數 > empty_order_threshold:
    拉黑 user_id + username → 返回 level = -5
```

#### 9.3 單筆信評限額

```python
# 判斷大額/小額
IF amount > single_transaction_threshold:
    applicable = 'large_amount'
ELSE:
    applicable = 'small_amount'

single_max_rating_amount = (depositsum / depositcnt) × (1 + rating_amount_bonus[applicable] / 100)
```

#### 9.4 封頂信評統計

```python
# 判斷大額/小額（用 ceiling_threshold）
interval_hours = max_rating_amount_interval[applicable]
rating_amount = 區間內已信評金額
rating_count  = 區間內已信評次數
```

#### 9.5 計算實際等級

```python
IF NOT 通過概率(rating_probability):   → level = 0 (rating_fail=True)
ELIF amount > single_max_rating_amount: → level = 0
ELIF rating_amount + amount > max_rating_amount OR
     rating_count + 1 > max_rating_count: → level = 0
ELSE: level = rating_level
```

#### 9.6 降等保護（RISK-25）

```python
IF rating_level > level:
    FOR 每個 demotion_protection_setting:
        IF level_range[min] <= rating_level <= level_range[max]:
            IF amount_range[min] <= amount <= amount_range[max]:
                level = rating_level  # 恢復
                trig_downgrade = 'Y'
                BREAK
```

---

### 第十步：異名比對（可選）

開關：`unusual_name_comparison_switch` + `member_switch.unusual_name_comparison`
觸發時記錄 `diff_name: {CurrentName, LastName}`

---

### 第十一步：非同步任務

- 空單屏蔽（deviceid/IP 維度）
- 系統部用戶資料同步

---

## 等級定義

| 等級 | 說明 |
|------|------|
| LV0, LV1, LV2... | 一般用戶，依充值筆數遞增 |
| -1 | 白名單特殊等級 |
| -5 | 黑名單 / 特殊髒款 / 空單屏蔽 |
| 13 | 代理線白名單 |

---

## 關鍵參數對照

| 參數 | 用途 | 分大額/小額 |
|------|------|------------|
| `single_transaction_threshold` | 單筆信評限額判斷基準 | 是 |
| `ceiling_threshold` | 封頂統計判斷基準 | 是 |
| `rating_amount_bonus` | 單筆加成比例 | 是 |
| `max_rating_amount` | 封頂金額限制 | 是 |
| `max_rating_count` | 封頂次數限制 | 是 |
| `max_rating_amount_interval` | 封頂統計時間區間（小時） | 是 |
| `rating_probability` | 信評通過概率（%） | 否 |
| `rating_interval` | 評級記錄時間間隔（天） | 否 |
| `empty_order_threshold` | 空單屏蔽閾值 | 否 |

---

## 關聯用戶機制

**定義**：同平台 + 同 userid 或 username 的所有用戶

**作用範圍**：黑名單查詢、白名單查詢（user_id）、空單屏蔽、封頂信評統計、歷史評級查詢

---

## 輸出格式

```json
{
    "message": "白名單用戶進線(...) / 黑名單用戶進線(...) / 一般用戶進線 / 特殊髒款屏蔽 / 觸發刷單屏蔽策略(ID)",
    "member_code": "商戶代碼",
    "userid": "用戶ID",
    "level": 1,
    "trig_downgrade": "Y/N",
    "diff_name": {"CurrentName": "...", "LastName": "..."}
}
```

---

## creditlevel_record 關鍵欄位

`level`、`rating_level`、`in_blacklist/whitelist`、`depositcnt`、`amount`、`rating_fail`、`rating_probability`、`single_max_rating_amount`、`rating_amount/count`、`max_rating_amount/count`、`demotion_protection`、`condition_detail`（JSON，含白名單觸發ID/次數、特殊髒款資訊、異名比對）
