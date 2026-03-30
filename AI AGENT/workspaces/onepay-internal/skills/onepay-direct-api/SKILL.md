---
name: onepay-direct-api
description: OnePay 充值建單（Direct API）配對提現單，包含 ELK 查詢步驟、sign 算法、回調觸發
---

# OnePay Direct API - 充值建單 Skill

## 📋 功能說明

使用 OnePay Direct API 建立充值單，用於配對項目方的提現單，並觸發回調通知。

## 🔧 環境配置

### API 端點
- **Pre 環境**: `https://pre.channel.1-pay.co/api/auction/direct/recharge/create`
- **Beta 環境**: `https://beta.channel.1-pay.co/api/auction/direct/recharge/create`
- **正式環境**: 待補充

### 回調端點（補單成功/失敗）
- **Pre 環境**: `https://pre.channel.1-pay.co/api/ai/exec`
- functionType: `RechargeSetting`（充值成功）/ `WithdrawSetting`（提現回調 / 搶單池失敗）

### Secrets 配置
- **檔案位置**: `~/.openclaw/workspace/secrets/onepay-platforms.json`
- **Ian 常用平台**: `JSIANTEST01`

### ELK 查詢配置
- **URL**: `http://onepay-kibana.1-pay.co:9200`
- **認證**: 從 `~/.openclaw/secrets/elk.sh` 讀取（`export ELK_USER=...` / `export ELK_PASS=...`）；執行前先 `source ~/.openclaw/secrets/elk.sh`
- **索引**:
  - Pre: `pre-channel-cn*`
  - Beta: `beta-channel-cn*`
  - 正式: `ph-ol-channel-cn*`

---

## 📖 使用流程

### Step 1: 解析提現單訊息

**格式範例**:
```
9015674 as pre提款，麻烦配对回调成功
202603110102 pre提款，麻烦配对回调成功
```

**解析規則**:
| 欄位 | 範例值 | 說明 |
|------|--------|------|
| 商戶單號 | `202603110102` | 提現訂單號（原始） |
| 平台代碼 | `as`（可選） | 對應 onepay 的 memberid／平台識別 |
| 環境 | `pre` | `pre` / `beta` / 不帶=正式(ol) |
| 操作 | `提款，配对回调成功` | 提現 + 要求配對並回調成功 |

**前綴規則**（查 ELK 時使用）：
| 平台 | 前綴 | 範例 |
|------|------|------|
| `as` | `AS_` | `9015674` → `AS_9015674` |
| **未指定平台代碼** | **不加前綴** | `202603110102` → `202603110102` |

---

### Step 2: 查詢 ELK 取得提現資訊

#### 2.1 查詢提現單基本資訊

> ⚠️ `change_logs` 欄位是 **JSON 字符串**，必須先 `json.loads()` 才能解析，不能直接當 object 用。

```bash
curl -s -u "$ELK_USER:$ELK_PASS" \
  -X POST "http://onepay-kibana.1-pay.co:9200/pre-channel-cn*/_search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "query_string": {
        "query": "{ORDER_NO} AND cache_withdraw_order"
      }
    },
    "size": 5,
    "sort": [{"@timestamp": {"order": "desc"}}],
    "_source": ["@timestamp", "message", "change_logs"]
  }'
```

**從 `change_logs`（JSON string）解析以下欄位**：

| 欄位路徑 | 用途 |
|----------|------|
| `change_logs.amount` | 提現金額，充值金額必須完全一致 |
| `change_logs.user_id` | 提現 userid，充值 userid **不能相同** |
| `change_logs.break_list[0].auctionMode` | ⭐ 支付方式（1=JFB, 2=Alipay, 3=WeChat），充值 `auction_mode` **必須與此相同** |
| `change_logs.break_list[0].status` | 集團風控＋池路由狀態：`1`=PLATFORM_REVIEW（審核中）；`2`=WAIT（**搶單池路由確認**）；`8`=WAIT_BREAK_RISK（餘額池審核中）；空=無集團風控阻攔；⚠️ `break_list` 可能為 `null`，此時視為空；⚠️ **此 status ≠ 訂單 status**（`change_logs.status`），兩者含義完全不同 |
| `change_logs.break_list[0].platformOrder` | 商戶單號（status=1 查集團風控通知時使用）；若 break_list 為 null 則改看頂層 `platform_order` |
| `change_logs.break_mode` | 池配置參考值：`'3'` = 餘額池模式設定；但**實際路由以 `break_list[0].status` 為準**（status=2→搶單池，status=8→餘額池）；`break_mode + pool 查詢` 作為輔助確認 |
| `change_logs.withdraw_order` | OnePay WDR 號（餘額池操作必須用此號查 pool） |

**Python 解析範例**：
```python
import json
change_logs     = json.loads(hit["_source"]["change_logs"])
amount          = str(int(change_logs["amount"]))                          # e.g. "100"
withdraw_userid = change_logs["user_id"]                                   # e.g. "202603110102"
_raw_bl         = change_logs.get("break_list")
# ⚠️ 修改記錄的 break_list 是 {"old":[...],"new":[...]} dict；新增記錄是 list
_break_list     = (_raw_bl.get("new") if isinstance(_raw_bl, dict) else _raw_bl) or []
_bl0            = _break_list[0] if _break_list else {}
auction_mode    = str(_bl0.get("auctionMode", ""))                         # e.g. "2"；若為空則從 2B-1 pool log 取 options.auctionMode
break_list_status = str(_bl0.get("status", ""))                            # "1"=PLATFORM_REVIEW, "2"=WAIT(搶單池), "8"=WAIT_BREAK_RISK；空=無阻攔
platform_order  = _bl0.get("platformOrder") or change_logs.get("platform_order", "")  # 商戶單號（status=1 查集團風控用）
break_mode      = str(change_logs.get("break_mode", ""))                   # '3' = 餘額池配置
withdraw_order  = change_logs.get("withdraw_order", "")                    # WDR 號
```

#### 2.1b 用 WDR 號重查最新 break_list 狀態（必做）

> ⚠️ **break_list 更新 log 的 `change_logs` 只含 `break_list/updated_at`，不含商戶單號/user_id。**
> 若只用商戶單號查 ELK，**更新 log 查不到**，只能看到建立 log 的 status=1，導致誤判仍在審核。
> **必須用 Step 2.1 取得的 `withdraw_order`（WDR 號）再查一次，覆蓋 break_list 狀態。**

```bash
# WDR_NO = withdraw_order  # 從 Step 2.1 解析出的 WDR 號
curl -s -u "$ELK_USER:$ELK_PASS" \
  -X POST "http://onepay-kibana.1-pay.co:9200/pre-channel-cn*/_search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {"query_string": {"query": "\"{WDR_NO}\" AND cache_withdraw_order"}},
    "size": 5,
    "sort": [{"@timestamp": {"order": "desc"}}],
    "_source": ["@timestamp", "change_logs"]
  }'
```

**從最新有 `break_list` 的 hit 取最終狀態（迭代，優先取 dict 型 break_list.new）**：
```python
for hit in wdr_hits["hits"]["hits"]:
    cl_raw = hit["_source"].get("change_logs")
    if not cl_raw:
        continue
    cl = json.loads(cl_raw)
    raw_bl = cl.get("break_list")
    if raw_bl is None:
        continue
    bl_list = (raw_bl.get("new") if isinstance(raw_bl, dict) else raw_bl) or []
    if bl_list:
        # 用最新有效 break_list 覆蓋 2.1 的值
        _bl0            = bl_list[0]
        break_list_status = str(_bl0.get("status", ""))
        if _bl0.get("auctionMode"):
            auction_mode = str(_bl0["auctionMode"])
        if _bl0.get("platformOrder"):
            platform_order = _bl0["platformOrder"]
        break  # 取最新的就夠了
```

> ℹ️ 若 WDR 查詢取得的 `break_list_status` 與 2.1 不同（如 2.1 是 1、WDR 查是 2），**以 WDR 結果為準**。

---

#### 2.2 查詢提現單的 memberid ⭐ **關鍵步驟**

> ⚠️ **配對成功的關鍵**：充值單的 `memberid` 必須與提現單的 `wdr_memberid` 完全一致！

**查詢方式**：用 `wdr_memberid AND {ORDER_NO}` 搜尋，找「商戶取得極速提現中間站網址資訊」那筆 log。

```bash
curl -s -u "$ELK_USER:$ELK_PASS" \
  -X POST "http://onepay-kibana.1-pay.co:9200/pre-channel-cn*/_search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "query_string": {
        "query": "\"wdr_memberid\" AND \"{ORDER_NO}\""
      }
    },
    "size": 3,
    "sort": [{"@timestamp": {"order": "desc"}}],
    "_source": ["@timestamp", "message"]
  }'
```

> ℹ️ `商戶提現風控審核通知` 這個 keyword 有時查不到（訊息格式可能不同），
> 改用 `wdr_memberid AND {orderNo}` 更穩定，會找到「商戶取得極速提現中間站網址資訊」log。

**從 `message` 欄位解析 `wdr_memberid`**：

```json
{
  "message": "商戶取得極速提現中間站網址資訊\n, params={\"wdr_memberid\":\"JSIANTEST01\",\"wdr_applydate\":\"...\", ...}"
}
```

**Python 解析範例**：
```python
import re
message = hit["_source"]["message"]
m = re.search(r'wdr_memberid[\"\\]*:[\"\\]*([A-Z0-9]+)', message)
if m:
    wdr_memberid = m.group(1)  # e.g. "JSIANTEST01"
```

---

### Step 2.5: 集團風控（PLATFORM_REVIEW）前置確認

> ⚠️ **必須在建單前完成此步驟，否則配對必定失敗（bank_account=null）。**
> ❗ `break_list[0].status=2`（WAIT）= 搶單池路由已確認（即使 break_mode=3 也優先走 Step 3，不走 Workflow 2B）。
> ❗ **ELK 中出現「成功」字樣不代表訂單已完成付款**：`建立資金池提現單(審核成功)` = 集團風控通過；`商戶提現風控審核通知 wdr_status="1"` = 審核通過；infogen `returncode:"00"` = API 調用正常。以上均非最終付款成功。

**status = 2（WAIT，PLATFORM_REVIEW 已過審）**：
→ 訂單路由為**搶單池**（即使 break_mode=3 也以此為準）→ 直接走 Step 3

**status = 1（PLATFORM_REVIEW，集團風控審核中）**：
1. 從 Step 2.1 的 `platform_order`（`change_logs.break_list[0].platformOrder`）取得商戶單號
2. 查 ELK channel-cn：keyword = `「商戶提現風控審核通知」AND {platform_order}`
3. 有命中 → 已過審 → 重查最新 break_list 確認更新後 status（取 `break_list.new[0].status`）：
   - `status=2`（WAIT）→ 搶單池 → 走 Step 3
   - `status=8`（WAIT_BREAK_RISK）→ 餘額池 → 走 Workflow 2B
   - 其他 → 依 `break_mode=3` 走 Workflow 2B；否則走 Step 3
4. 無命中 → **停止**，回覆：`⚠️ {單號} 集團風控過審中，待審批通過後方可配對`

**status = 8（WAIT_BREAK_RISK，餘額池等待風控）**：
1. 查 ELK channel-cn：keyword = `「商戶提現等待風控審核通知」AND {WDR單號}`（WDR單號 = Step 2.1 的 `change_logs.withdraw_order`，非訊息中的商業訂單號）
2. 有命中 → 已過審，**繼續 Workflow 2B（詳見下方）**
3. 無命中 → **停止**，告知集團風控過審中

**break_list = null 或 status 為空（純餘額池，無集團風控流程）→ 無阻攔，直接繼續 Workflow 2B**

**其他 status（如 0，無集團風控阻攔）→ 直接繼續（break_mode=3 走 Workflow 2B；其他走 Step 3）**

> ℹ️ 此處查通知用於**判斷是否過審**，與 Step 2.2 的 `wdr_memberid` 查詢是不同目的，互不影響。

---

### Workflow 2B：餘額池拆單配對（break_mode = 3）

> ⚠️ 前提：Step 2.5 已確認集團風控過審。
> ⚠️ 拆單全程**預設不打 RechargeSetting**，一律只打 WithdrawSetting（子 WDR 號）；除非對方明確指示「充值單也要回調」才例外（見步驟 3）。
> ⚠️ 逐筆執行：一筆建單＋回調完成，才建下一筆。

#### 2B-1 查 pool 狀態

```bash
# keyword: "{withdraw_order} AND remaining_balance"
# index: {env}-channel-cn*
```
（⚠️ 注意：直接用 `pool_withdraw_balances` 作為搜尋關鍵字可能查無結果，請用上方 keyword）

> ⚠️ 若查**無結果**：pool 可能尚未建立，或訂單實際路由為搶單池，或集團風控待審核中。
> - **break_list[0].status=2（WAIT）**：PLATFORM_REVIEW 已過審，訂單路由為**搶單池** → 直接改走 Step 3（不需重試）
> - **break_list[0].status=8（WAIT_BREAK_RISK）**：餘額池等待集團風控審批中，pool 待過審後才建立 → **停止**，告知用戶等候審批
> - **break_list=null（無集團風控）**：等 5 秒後重查一次；仍無結果 → 改走 Step 3（搶單池）
> - **break_list[0].status=1（PLATFORM_REVIEW 未過審）**：需等集團風控過審後 pool 才建立；告知用戶等候
> ❗ 「無結果」不等於搶單池，先確認 break_list[0].status 再判斷。

從結果取（**pool log 也在 channel-cn，不是 pool-cn**）：

| 欄位 | 來源 log | 用途 |
|------|---------|------|
| `remaining_balance.new` | 最新「修改 pool_withdraw_balance」log | 剩餘未配對金額 |
| `match_withdraws.new` | 最新「修改」log | 已配對金額列表（子單不可重複此金額） |
| `options.auctionMode` | 「新增 pool_withdraw_balances」log | ⭐ 充值 auction_mode |
| `options.maxWithdrawCount` | 「新增」log | 最多可拆幾筆 |
| `options.rejectWithdrawAmounts` | 「新增」log | 額外排除金額列表（這些金額不可使用） |
| `expired_at` | 「新增」log | ⭐ 池子到期時間 |

> ⚠️ 若距 `expired_at` 不足 2 分鐘，立即停止並回報：「池子即將到期，請重新建提現單」

#### 2B-2 決定子單金額

- 子單金額加總 = `remaining_balance`（非提現總金額，避免重複配對已配對部分）
- 各子單金額**不可相同**（例如 2000 不能拆 1000+1000，改 1200+800）（餘額池規則：同金額不能配對兩次，無論是否逐單完成）
- 各子單金額不可與 `match_withdraws` 已有金額重複（同理，已配對金額不可再用）
- 各子單金額不可在 `options.rejectWithdrawAmounts` 列表中（若有此欄位則排除）
- 筆數不可超過 `maxWithdrawCount`
- 若用戶指定金額則使用指定值；否則自行決定（建議整數，例如 2000→1200+800）

#### 2B-3 逐筆執行（每筆完整走完再處理下一筆）

**每筆子單執行順序：**

**1. 建充值單**（同 Step 3，但 amount = 子單金額，userid/username 每筆不同）
- userid 格式：`{YYYYMMDD}0201`、`0202`...；username 同 userid（**兩者都要換**）
- ⚠️ 只換 userid 不換 username → returncode: 13「同用户重复建单」
- ⚠️ `userip` 必須是 IP 格式（如 `23.12.8.1`），**不能與 userid 相同**（否則無法配對）
- 確認配對成功：`pay_bankcard.bank_account` 不為 null

**2. 取子 WDR 號**（⭐ 每次配對後必做，WithdrawSetting 必須用子 WDR 號）
- **第 1 筆**：子 WDR 號 = `withdraw_order`（母單號，相同）
- **第 2 筆起**：查 ELK channel-cn，keyword = `"{withdraw_order} AND wdr_mainorder"`
  - 從 `req_content` 欄位解析最新的 `withdraw_order`（⚠️ 不是 `change_logs`；`change_logs` 可能為空，不可作為備選）
  - req_content 格式：`{"withdraw_order":"WDR...子單號","wdr_mainorder":"WDR...母單號","wdr_amount":800,...}`

**3. 執行 WithdrawSetting**（同 Step 5，但 orderid = 子 WDR 號）
- 回調成功：status=1；回調失敗：status=0；不回調/等超時：跳過直接建下一筆
- ⚠️ 同一子 WDR 先 status=1 再 status=0 → 404，順序要一次到位
- ⚠️ 唯一例外：對方明確說「充值單也要回調」才另外打 RechargeSetting（orderid=PAY 號，status 依指示）

---

### Step 3: 建立充值單並驗證配對（搶單池 Workflow 2）

> ⚠️ 此步驟為**搶單池（Workflow 2）**流程，amount = 提現總金額。
> ⚠️ **餘額池（Workflow 2B）**請見上方 Workflow 2B 章節，不走此步驟。

#### ⭐ 配對成功的關鍵規則（已驗證）

1. **`memberid` 必須與提現單的 `wdr_memberid` 完全一致** ⭐ **最關鍵**
   - 從 ELK Step 2.2 取得 `wdr_memberid`，Direct API `memberid` 必須使用這個值
2. **`auction_mode` 必須與提現單的 `auctionMode` 完全一致**
   - 從 ELK `change_logs.break_list[0].auctionMode` 讀取，不能寫死
   - 1=JFB, 2=Alipay, 3=WeChat
3. **充值 `userid` 不能與提現 `userid` 相同**
   - 格式：`{YYYYMMDD}{4位序號}`，建議從 `0201` 開始（提現方從 `0101` 起）
4. **`userid` 與 `userip` 的值不能相同**
   - `userip` 必須是 IP 格式（如 `23.12.8.1`），不能使用 userid 的日期序號格式
5. **金額必須完全一致**
   - 從 ELK `change_logs.amount` 取整數後轉字串

#### ⭐ 配對成功的判斷方式（已驗證）

> ⚠️ `returncode=00` 只代表**建單成功**，不代表配對成功！
>
> ✅ **配對成功**：`pay_bankcard.bank_account` 有值（不為 null）
> ❌ **未配對**：`pay_bankcard` 的 `bank_account` 為 null（提現單逾時、被配走或條件不符）
>
> `pay_bankcard` 是 dict 但內容全 null 是常見陷阱，必須檢查內容而非只判斷 dict 是否存在。

#### 完整 Python 建單腳本

```python
import hashlib, json, subprocess, re
from datetime import datetime

# ── 從 ELK Step 2.1 取得 ──────────────────────────────────────
amount          = "100"             # change_logs.amount
withdraw_userid = "202603110102"    # change_logs.user_id
auction_mode    = "2"               # change_logs.break_list[0].auctionMode

# ── 從 ELK Step 2.2 取得 ──────────────────────────────────────
wdr_memberid = "JSIANTEST01"        # 從 wdr_memberid 關鍵字查詢取得

# ── 讀取 secrets ──────────────────────────────────────────────
import os as _os
with open(_os.path.expanduser('~/.openclaw/workspace/secrets/onepay-platforms.json')) as f:
    platforms = json.load(f)
memberid   = platforms[wdr_memberid]["memberid"]
secret_key = platforms[wdr_memberid]["secret_key"]

# ── 建單參數 ──────────────────────────────────────────────────
ts           = int(datetime.now().timestamp() * 1000)
orderid      = f"test_auction_recharge_{ts}"
datetime_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
userid       = f"{datetime.now().strftime('%Y%m%d')}0201"  # 不能與 withdraw_userid 相同
userip       = "23.12.8.1"
notifyurl    = "https://pre.channel.1-pay.co/api/test/auction/recharge/fake/notifyurl"
infourl      = "https://pre.channel.1-pay.co/api/test/auction/recharge/fake/infourl"

ext = {
    "userid": userid, "username": userid, "userip": userip,
    "betrate": 0.9, "wwdepositsum": 20000, "betcnt": 100, "pwtimerange": 180,
    "regddate": "2020-01-01 12:00:00",
    "depositcnt": 200, "depositsum": "3000000",
    "depositcnt2": 200, "depositsum2": "3000000",
    "depositcnt3": 200, "depositsum3": "3000000",
    "withdrawsum": "2000000", "wwbetsum": 30000,
    "balance": 0, "profitsum": -100,
    "agent": "xingyun@xy6>yk121288@xy6>wangke8@xy6>ninasky@xy6",
    "deviceid": f"Win10-Chrome-{ts}",
    "realName": userid
}
ext_str = json.dumps(ext, ensure_ascii=False)

# 簽名（順序固定：memberid → orderid → amount → datetime → notifyurl → infourl → secret_key）
raw  = memberid + orderid + amount + datetime_str + notifyurl + infourl + secret_key
sign = hashlib.md5(raw.encode()).hexdigest()

payload = {
    "memberid": memberid, "orderid": orderid, "amount": amount,
    "datetime": datetime_str, "auction_mode": auction_mode,  # ⭐ 從 ELK 讀，不寫死
    "notifyurl": notifyurl, "infourl": infourl,
    "userid": userid, "userip": userip, "ext": ext_str, "sign": sign
}

# 呼叫 API（用 curl，避免 requests 套件相依問題）
with open("/tmp/recharge_payload.json", "w") as f:
    json.dump(payload, f, ensure_ascii=False)

result = subprocess.run(
    ["curl", "-s", "-X", "POST",
     "https://pre.channel.1-pay.co/api/auction/direct/recharge/create",
     "-H", "Content-Type: application/json",
     "-d", "@/tmp/recharge_payload.json"],
    capture_output=True, text=True
)
resp = json.loads(result.stdout)
print(json.dumps(resp, indent=2, ensure_ascii=False))

# ⭐ 正確的配對判斷：檢查 bank_account 是否有值（非 null）
pay_bankcard = resp.get("pay_bankcard") or {}
bank_account = pay_bankcard.get("bank_account")

if resp.get("returncode") == "00" and bank_account:
    print(f"✅ 配對成功！充值單號：{resp['merchant_order']}")
    print(f"   收款卡：{pay_bankcard.get('bank_account_name')} / {pay_bankcard.get('bank_code')}")
else:
    print(f"❌ 未配對到提現單（bank_account={bank_account}），停止，不執行回調")
```

#### 成功回應範例（已配對）

```json
{
  "returncode": "00",
  "message": "成功",
  "merchant_order": "PAY0016852026031119212700000615",
  "pay_bankcard": {
    "bank_account": "TESTTEST",
    "bank_account_name": "TEST",
    "bank_code": "JFB",
    "bank_area": "JFB",
    "qrcode": ""
  },
  "pay_amount": "100"
}
```

#### 未配對回應範例（逾時或條件不符）

```json
{
  "returncode": "00",
  "message": "成功",
  "merchant_order": "PAY0016852026031119133200000610",
  "pay_bankcard": {
    "bank_account": null,
    "bank_account_name": null,
    "bank_code": "",
    "bank_area": null,
    "qrcode": ""
  }
}
```

---

### Step 4: 觸發回調成功（RechargeSetting）

> ⚠️ **必須在 Step 3 確認配對成功後才執行此步驟。**
> `/api/ai/exec` 即使沒有真正配對也會回 `{"code":200}`，不能用回應來判斷補單是否成功。
> ⚠️ **此步驟僅用於回調「成功」（status=1）**。
> 回調「失敗」須改用 WithdrawSetting（對 WDR 號，status=0），否則提現單會重新進配對池重試。

```python
import json, subprocess

merchant_order = "PAY0016852026031119212700000615"  # Step 3 取得
amount         = "100"                               # 與提現金額一致

data = json.dumps({
    "functionType": "RechargeSetting",
    "orderid": merchant_order,
    "status": "1",       # 固定為 1（失敗請用 WithdrawSetting，見 Step 5）
    "amount": amount,
    "reason": "人工補單成功"
})
payload = json.dumps({"data": data})

result = subprocess.run(
    ["curl", "-s", "-X", "POST",
     "https://pre.channel.1-pay.co/api/ai/exec",
     "-H", "Content-Type: application/json",
     "-d", payload],
    capture_output=True, text=True
)
print(result.stdout)
# 預期回應: {"code":200,"message":"請求成功"}
```

---

### Step 5: 提現單回調（WithdrawSetting）

> 適用場景：
> - **搶單池回調失敗**：orderid = 原始 WDR 號（Step 2.1 的 withdraw_order），status=0
> - **餘額池（Workflow 2B）**：orderid = 子 WDR 號（第 1 筆 = 母單號，第 2 筆起查 ELK `wdr_mainorder` 取得），status=1/0
>
> 搶單池回調**成功**請用 Step 4（RechargeSetting）。
> ⚠️ **前置條件：提現單必須已配對充值單**，否則 API 回傳 404。

```python
import json, subprocess

orderid = "WDR0016852026031315124300000020"  # 提現訂單號
status  = "0"    # 1=成功, 0=失敗
reason  = "人工操作失敗"
env     = "pre"  # pre / ol

base_url = {
    "pre": "https://pre.channel.1-pay.co",
    "ol":  "https://channel.1-pay.co",
}.get(env, "https://pre.channel.1-pay.co")

data = json.dumps({
    "functionType": "WithdrawSetting",
    "orderid": orderid,
    "status": status,
    "reason": reason
})
payload = json.dumps({"data": data})

result = subprocess.run(
    ["curl", "-s", "-X", "POST",
     f"{base_url}/api/ai/exec",
     "-H", "Content-Type: application/json",
     "-d", payload],
    capture_output=True, text=True
)
print(result.stdout)
# 預期回應: {"code": 200, "message": "請求成功"}
```

**參數說明：**

| 參數 | 必填 | 說明 |
|------|------|------|
| `functionType` | ✅ | 固定為 `WithdrawSetting` |
| `orderid` | ✅ | 子提現單號（子 WDR 號，非 PAY 號） |
| `status` | ✅ | `1`=成功，`0`=失敗 |
| `reason` | ✅ | 操作原因（自由填寫） |

**請求範例：**
```json
{
  "data": "{\"functionType\": \"WithdrawSetting\", \"orderid\": \"WDR0016852026031315124300000020\", \"status\": \"0\", \"reason\": \"test\"}"
}
```

**回應範例：**
```json
{"code": 200, "message": "請求成功"}
```

> ⚠️ 與 `RechargeSetting` 相同：`code: 200` 不代表操作確實生效，需透過 ELK 或後台確認訂單狀態已變更。

---

## ✅ 成功案例

### 案例 1（2026-03-09）- 訂單 202603090101
- **提現單**: `WDR001685...`，金額 100，auctionMode=2（Alipay），userid=`202603090101`
- **充值單**: `PAY0016852026030913371700000135`
- **結果**: ❌ 未配對（auction_mode 未匹配）

### 案例 2（2026-03-09）- 訂單 AS_9015714 ✅
- **提現單**: 金額 200，auctionMode=3（WeChat），**wdr_memberid=JSTEST06**
- **充值單**: `PAY0017612026030915002200000232`，memberid=JSTEST06，auction_mode=3
- **結果**: ✅ 配對成功（`pay_bankcard.bank_account` 有值）
- **回調**: 使用 payment 後台路由（舊方式，MCP 接入前）

### 案例 3（2026-03-11）- 訂單 202603110101 ❌
- **提現單**: `WDR0016852026031118395300000056`，金額 100，auctionMode=2，wdr_memberid=JSIANTEST01
- **充值單**: `PAY0016852026031119133200000610`
- **結果**: ❌ 未配對（`pay_bankcard.bank_account=null`）— 提現單已逾時
- **回調**: 誤觸發，`/api/ai/exec` 回 200 但補單無效 ⚠️

### 案例 4（2026-03-11）- 訂單 202603110102 ✅
- **提現單**: `WDR0016852026031119182800000057`，金額 100，auctionMode=2（Alipay），userid=202603110102，**wdr_memberid=JSIANTEST01**
- **充值單**: `PAY0016852026031119212700000615`，memberid=JSIANTEST01，userid=202603110201，auction_mode=2
- **結果**: ✅ 配對成功（`pay_bankcard.bank_account=TESTTEST`）
- **回調**: ✅ `/api/ai/exec` RechargeSetting，status=1，amount=100 → `{"code":200}`
- **成功關鍵**:
  1. ✅ memberid 與提現單一致（JSIANTEST01）
  2. ✅ auction_mode 從 ELK 讀取（2=Alipay）
  3. ✅ 金額一致（100）
  4. ✅ userid 與提現不同（0201 vs 0102）
  5. ✅ 配對後才觸發回調（先驗證 bank_account 非 null）

---

## ⚠️ 重要注意事項

| 項目 | 規則 |
|------|------|
| `auction_mode` | **必須**從 ELK `change_logs.break_list[0].auctionMode` 讀取，不能寫死 |
| `userid` | 充值 userid 不能與提現 userid 相同，用 `{YYYYMMDD}0201` 起 |
| `amount` | 必須與提現金額完全一致（整數字串） |
| `ext` | 必須先 `json.dumps()` 成字符串，不能直接放 object |
| `userip` | 必填；必須是 IP 格式（如 `23.12.8.1`）；**不能與 `userid` 相同**，否則無法配對 |
| `change_logs` | ELK 回傳的是 JSON **字符串**，必須先 `json.loads()` 解析 |
| HTTP 請求 | 用 `curl` 發送（避免 `requests` 套件相依問題） |
| **配對判斷** | `pay_bankcard.bank_account != null` 才是真正配對成功，dict 存在但內容全 null = 未配對 |
| **回調時機** | 必須先確認配對成功再呼叫 `/api/ai/exec`，否則補單無效但回應仍為 200 |
| **平台前綴** | 有 `as` → 加 `AS_`；未指定平台代碼 → 不加前綴，直接用原始單號查 ELK |
| **兩個 status 不能混淆** | `change_logs.status`（提現單整體狀態，2=成功/終態）≠ `change_logs.break_list[0].status`（集團風控/池路由，2=WAIT=搶單池）；看到 ELK log 有 status=2 **不代表訂單已完成** |
| **ELK「成功」≠ 訂單成功** | `建立資金池提現單(審核成功)` = 集團風控通過；`wdr_status="1"` = 審核通過；infogen `returncode:"00"` = API 正常；均**不代表提現單已付款完成** |

---

## 🔍 排查工具

### 查詢充值單狀態（ELK）
```bash
curl -s -u "$ELK_USER:$ELK_PASS" \
  -X POST "http://onepay-kibana.1-pay.co:9200/pre-channel-cn*/_search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {"query_string": {"query": "PAY0016852026031119212700000615"}},
    "size": 20,
    "sort": [{"@timestamp": {"order": "desc"}}]
  }' | python3 -m json.tool
```

### 常見錯誤

| 錯誤 | 原因 | 解決 |
|------|------|------|
| `pay_bankcard.bank_account` 為 null | 提現單逾時 / 條件不符（amount/auction_mode/memberid） | 確認提現單仍活躍，重新查 ELK 確認三項條件 |
| `pay_bankcard` 為空 object | 同上 | 同上 |
| `/api/ai/exec` 回 200 但補單沒效 | 未真正配對就觸發回調 | 先驗證 `bank_account` 非 null |
| `参数验证失败 userip 不能为空` | 缺少 `userip` | 加上 `"userip": "23.12.8.1"` |
| `returncode: 03` | 參數驗證失敗 | 檢查 sign 順序和必填參數 |
| `change_logs` 解析錯誤 | 當 object 用 | 先 `json.loads(change_logs)` |
| ELK 查 memberid 查無結果 | `商戶提現風控審核通知` keyword 不穩定 | 改用 `wdr_memberid AND {orderNo}`（此限 Step 2.2 查 memberid；集團風控通知查詢仍使用原 keyword，見 Step 2.5） |

---

## 📚 參考文件

- **PM Ops Spec**: `docs/pm-ops-spec.md`
- **Secrets**: `~/.openclaw/workspace/secrets/onepay-platforms.json`
- **ELK Keywords**: `docs/elk-keywords.md`
