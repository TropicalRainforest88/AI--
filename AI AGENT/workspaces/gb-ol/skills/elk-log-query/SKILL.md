---
name: elk-log-query
description: Query device logs from ELK via MCP API. Use when user asks to check logs, diagnose device issues, search by SOC IP, SSR IP, or bank code. Supports log search, evidence diagnosis, cross-device queries, video clips, and device metadata.
---

# ELK Log Query

Query Elasticsearch logs via the ELK MCP server at `http://10.61.150.50:8080/mcp`.

## Available Tools

| Tool | Purpose |
|------|---------|
| `elk_healthz` | Check ELK service health |
| `elk_search_logs` | Search raw logs by device IP |
| `elk_evidence_query` | Diagnose a problem with structured evidence |
| `elk_query_by_ssr` | List devices by SSR IP |
| `elk_query_by_bank` | List devices by bank code |
| `elk_get_device_metadata` | Fetch device metadata (WeChat/App version) |
| `elk_get_soc_video_clip_v1` | Get SOC monitor video clip |
| `elk_get_soc_screenshots_v1` | Fetch SOC monitor screenshots by time range |
| `elk_get_soc_screenshot_images_v1` | Get screenshot binary data (base64 JPEG) |

## How to Call

All calls use `curl` with JSON-RPC POST to `http://10.61.150.50:8080/mcp`.

**Template:**
```bash
curl -s -X POST "http://10.61.150.50:8080/mcp" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer __ELK_MCP_TOKEN__" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"<TOOL_NAME>","arguments":{<ARGS>}},"id":1}'
```

## Tool Details

### 1. elk_healthz — Health Check

```bash
curl -s -X POST "http://10.61.150.50:8080/mcp" -H "Content-Type: application/json" -H "Authorization: Bearer __ELK_MCP_TOKEN__" -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"elk_healthz","arguments":{}},"id":1}'
```

### 2. elk_search_logs — Search Device Logs

Required: `soc_ip` + either `approx_log_time` OR (`time_from` + `time_to`)

```bash
curl -s -X POST "http://10.61.150.50:8080/mcp" -H "Content-Type: application/json" -H "Authorization: Bearer __ELK_MCP_TOKEN__" -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"elk_search_logs","arguments":{"soc_ip":"<IP>","approx_log_time":"<TIME>"}},"id":1}'
```

With explicit time range:
```bash
curl -s -X POST "http://10.61.150.50:8080/mcp" -H "Content-Type: application/json" -H "Authorization: Bearer __ELK_MCP_TOKEN__" -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"elk_search_logs","arguments":{"soc_ip":"<IP>","time_from":"<ISO8601>","time_to":"<ISO8601>","limit":100}},"id":1}'
```

Optional filters: `android_os_version`, `wechat_account`, `jinbao_app_version`, `wechat_app_version`, `limit` (1-1000, default 100), `cursor` (pagination)

### 3. elk_evidence_query — Problem Diagnosis

Required: `soc_ip`, `problem_description`, `actual_behavior` + time parameter

```bash
curl -s -X POST "http://10.61.150.50:8080/mcp" -H "Content-Type: application/json" -H "Authorization: Bearer __ELK_MCP_TOKEN__" -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"elk_evidence_query","arguments":{"soc_ip":"<IP>","approx_log_time":"<TIME>","problem_description":"<DESCRIPTION>","actual_behavior":"<BEHAVIOR>"}},"id":1}'
```

Optional: `repro_steps` (array), `expected_behavior`, `impact_scope`, `include_summary` (default true, set false for raw events only)

### 4. elk_query_by_ssr — Devices by SSR IP

Required: `ssr_ip`, `time_from`, `time_to`

```bash
curl -s -X POST "http://10.61.150.50:8080/mcp" -H "Content-Type: application/json" -H "Authorization: Bearer __ELK_MCP_TOKEN__" -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"elk_query_by_ssr","arguments":{"ssr_ip":"<IP>","time_from":"<ISO8601>","time_to":"<ISO8601>"}},"id":1}'
```

### 5. elk_query_by_bank — Devices by Bank Code

Required: `bank_code`, `time_from`, `time_to`

```bash
curl -s -X POST "http://10.61.150.50:8080/mcp" -H "Content-Type: application/json" -H "Authorization: Bearer __ELK_MCP_TOKEN__" -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"elk_query_by_bank","arguments":{"bank_code":"<CODE>","time_from":"<ISO8601>","time_to":"<ISO8601>"}},"id":1}'
```

Bank code format: uppercase, e.g. `JLRC_P`

### 6. elk_get_device_metadata — Device Metadata

Fetch latest device metadata by soc_ip. Returns WeChat/JinBao/Framework/Android version fields.

Required: `soc_ip`

```bash
curl -s -X POST "http://10.61.150.50:8080/mcp" -H "Content-Type: application/json" -H "Authorization: Bearer __ELK_MCP_TOKEN__" -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"elk_get_device_metadata","arguments":{"soc_ip":"<IP>"}},"id":1}'
```

Optional: `include_meta_text` (default true, include canonical multiline meta_text)

### 7. elk_get_soc_video_clip_v1 — SOC Video Clip

Required: `soc_ip`, `time_from`, `time_to` (max 10 seconds window)

```bash
curl -s -X POST "http://10.61.150.50:8080/mcp" -H "Content-Type: application/json" -H "Authorization: Bearer __ELK_MCP_TOKEN__" -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"elk_get_soc_video_clip_v1","arguments":{"soc_ip":"<IP>","time_from":"<ISO8601>","time_to":"<ISO8601>"}},"id":1}'
```

Optional: `include_source_videos` (default true, include source video list and used segment details)

### 8. elk_get_soc_screenshots_v1 — SOC Screenshots

Fetch SOC monitor screenshots by time range at a sampling interval. Frames extracted from source videos using ffmpeg.

Required: `soc_ip`, `time_from`, `time_to`

```bash
curl -s -X POST "http://10.61.150.50:8080/mcp" -H "Content-Type: application/json" -H "Authorization: Bearer __ELK_MCP_TOKEN__" -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"elk_get_soc_screenshots_v1","arguments":{"soc_ip":"<IP>","time_from":"<ISO8601>","time_to":"<ISO8601>"}},"id":1}'
```

Optional: `interval_seconds` (capture interval, default 0.5, range 0.1-5.0), `include_source_videos` (default false)

Note: Max 300 capture points, exceeding returns SCREENSHOT_TRUNCATED warning.

### 9. elk_get_soc_screenshot_images_v1 — Screenshot Image Data

Fetch screenshot binary data (base64 JPEG) from previously generated screenshot IDs. Use after `elk_get_soc_screenshots_v1`.

Required: `screenshot_ids` (array of filenames, max 20 per call)

```bash
curl -s -X POST "http://10.61.150.50:8080/mcp" -H "Content-Type: application/json" -H "Authorization: Bearer __ELK_MCP_TOKEN__" -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"elk_get_soc_screenshot_images_v1","arguments":{"screenshot_ids":["<ID1>","<ID2>"]}},"id":1}'
```

#### ⚠️ 重要：base64 禁止进入主 session context

截图 base64 数据量大，**严禁**直接在主对话中调用此工具。必须用子任务处理：

**步骤：**
1. 用 bash 脚本调用 API，将 base64 解码保存为 JPEG 文件到 `/tmp/shots/`
2. 用 `sessions_spawn` 启动独立子任务，传入图片路径，让子任务做 vision 分析
3. 子任务返回纯文字结论，主 session 只引用该文字结论

**参考脚本（保存并执行）：**
```bash
mkdir -p /tmp/shots && python3 - << 'PY'
import urllib.request, json, base64, sys
url = "http://10.61.150.50:8080/mcp"
headers = {"Content-Type": "application/json", "Authorization": "Bearer __ELK_MCP_TOKEN__"}
ids = sys.argv[1:] if len(sys.argv) > 1 else ["ID1","ID2"]
body = json.dumps({"jsonrpc":"2.0","method":"tools/call","params":{"name":"elk_get_soc_screenshot_images_v1","arguments":{"screenshot_ids":ids}},"id":1}).encode()
req = urllib.request.Request(url, body, headers)
resp = json.loads(urllib.request.urlopen(req).read())
import re, os
for i, item in enumerate(resp.get("result",{}).get("content",[])):
    if item.get("type") == "image":
        raw = item.get("name", f"shot_{i}")
        safe = re.sub(r'[^a-zA-Z0-9_\-]', '_', os.path.basename(raw))[:80] + ".jpg"
        path = f"/tmp/shots/{safe}"
        with open(path, "wb") as f:
            f.write(base64.b64decode(item["data"]))
        print(f"saved: {path}")
PY
```

**子任务 vision 分析 prompt 示例：**
```
分析 /tmp/shots/ 下的截图，描述每张图的画面内容：
- 是否有微信转账/收款界面
- 金额、收款方、时间等关键信息
- 是否有异常（如错误弹窗、黑屏）
只返回文字摘要，每张图 1-2 行。
```

## Pagination

When response contains `page.next_cursor`, pass it as `"cursor":"<value>"` in the next call to get more results.

## Time Format

- `approx_log_time`: flexible, e.g. `"2026-03-15 14:30"` (timezone optional, uses adaptive windows)
- `time_from` / `time_to`: ISO8601 with timezone required, e.g. `"2026-03-15T14:00:00+08:00"`

## Output Format

When presenting log search results to the user, always organize and format the data as follows:

### 1. Summary Table (必须)

```
{SOC_IP} 今天（{M/D}）跑了{N}家银行：

#   银行名称                     银行代码    卡号（尾码）
1   上海银行                     BOSC_P     6930
2   吉林农商银行（吉林农信）       JLRC_P     8115、9368（2张卡）
```

- Extract from `bankType` and `bankAccount` fields in raw_events
- Group cards by bank code, show last 4 digits
- Show card count in parentheses when a bank has multiple cards

### 2. Device Info

Use `elk_get_device_metadata` to fetch device metadata:

```
📋 设备信息：
- 微信号：{wechat_account}
- SSR：{ssr_ip}（心跳状态）
- App版本：{jinbao_app_version}
- 框架版本：{framework_version}
- Android版本：{android_os_version}
```

### 3. Task List

If log contains taskList, show it:

```
📋 log 在 {HH:MM:SS} 有一笔完整的任务清单：
taskList：[银行名(代码)卡号, ...]
```

### 4. Transaction Details (条列式)

If logs contain `DataBankTradeMessagesRe` transaction records, show in bullet format:

```
💰 从明细 log 可以看到今天已有以下交易被抓到：

• 卡号 6930（上海银行）共抓到 2 笔明细：
  - 00:10  网上交易转入  ¥1,999.00  余额 ¥5,068.63
  - 13:37  转出  ¥4,827.00  余额 ¥241.63

• 卡号 8115（吉林农商银行）共抓到 1 笔明细：
  - 09:22  转入  ¥5,000.00  余额 ¥8,230.50
```

- Group by card number, each card is a bullet (•), show total count of transactions
- Each transaction: time + type + amount (¥ prefix, comma formatting) + balance
- Sort by time ascending within each card

### 5. Error/Exception Records

If raw_events message contains Exception, Error, 失败, 超时 etc:

```
⚠️ 异常记录：
- [HH:MM:SS] {发生位置} → {错误内容}
```

### 6. SOC Monitor Video Clip

After log query, call `elk_get_soc_video_clip_v1` with last transaction time ±5 seconds.

If clip available:
```
🎬 监控影片：
  • 时间范围：{HH:MM:SS} ~ {HH:MM:SS} (UTC+8)
  • 时长：{N}秒
  • 影片链接：{clip_url}
```

If no clip or call fails:
```
🎬 监控影片：无影片
```

### 7. Problem Diagnosis (triggered only when user asks diagnostic questions)

When user asks "why no transactions", "what's wrong with the device", "why stuck" etc., call `elk_evidence_query`:

```
🔍 问题诊断：
  • 问题：{user's problem description}
  • 诊断结果：{summary from evidence_query}
  • 相关证据：
    - {evidence 1}
    - {evidence 2}
  • 建议：{suggested action}
```

### 8. Formatting Rules

- Always use Chinese for responses
- Must NOT stop at just "跑了N家银行" — full table with bank codes, card numbers, and transaction details required
- When data spans multiple pages (has `next_cursor`), fetch additional pages to get complete picture
- If no transactions found, state clearly: "今天暂无交易记录"
- Use limit=100 and time_from=today 00:00:00+08:00 for queries, paginate if needed

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Comma-separated soc_ip | Only single IP per call |
| Missing timezone in time_from/time_to | Always include timezone e.g. `+08:00` |
| Using both approx_log_time and time_from/time_to | Pick one or the other |
| Video clip > 10 seconds | Server truncates to 10s from time_from |
| Using old tool names without _v1 | Video/screenshot tools now end with `_v1` |
