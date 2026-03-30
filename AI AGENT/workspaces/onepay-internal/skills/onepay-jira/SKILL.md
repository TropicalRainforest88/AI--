---
name: onepay-jira
description: Jira issue 建立、查詢、更新，含 Markdown→Jira wiki markup 轉換與 issue type 模板
---

# Jira Issue Management

CRUD operations for Jira issues with Markdown-to-wiki-markup conversion.

## Pre-flight Checks

**每次使用此 skill 前，必須依序檢查：**

### 1. Token 檢查

檢查 `~/.openclaw/secrets/jira.sh` 是否存在且包含有效的 `JIRA_TOKEN`。

若不存在或 token 無效，引導使用者：
1. 登入 Jira（`https://jira.1-pay.co`）
2. 進入「個人設定」→「Personal Access Tokens」
3. 建立新 token，複製 token 值
4. 建立 `~/.openclaw/secrets/jira.sh`，寫入：
   ```bash
   export JIRA_URL="https://jira.1-pay.co"
   export JIRA_TOKEN="貼上你的 token"
   ```
5. 驗證：`source ~/.openclaw/secrets/jira.sh && curl -s -k "$JIRA_URL/rest/api/2/myself" -H "Authorization: Bearer $JIRA_TOKEN"`

### 2. 專案確認

若使用者未明確指定目標專案（project key），必須詢問：
- 「請問要在哪個 Jira 專案下建立 issue？（例如 CRYP、OPS 等）」
- 可透過 API 列出可用專案：`curl -s -k "$JIRA_URL/rest/api/2/project" -H "Authorization: Bearer $JIRA_TOKEN"`

### 3. Issue Type 確認

若使用者未指定 issue type，根據描述內容推斷，推斷不確定時詢問使用者。
不同專案的 issue type 可能不同，可透過 API 查詢：`curl -s -k "$JIRA_URL/rest/api/2/project/{PROJECT_KEY}" -H "Authorization: Bearer $JIRA_TOKEN"`

## Config

- **Base URL**: `https://jira.1-pay.co`
- **Auth**: `Authorization: Bearer $JIRA_TOKEN`
- **Token**: stored in `~/.openclaw/secrets/jira.sh`
- **API**: REST API v2 (`/rest/api/2/`)
- **SSL**: use `-k` flag (self-signed cert)

## Quick Reference: API Endpoints

| Operation | Method | Endpoint |
|-----------|--------|----------|
| Create issue | POST | `/rest/api/2/issue` |
| Get issue | GET | `/rest/api/2/issue/{KEY}` |
| Update issue | PUT | `/rest/api/2/issue/{KEY}` |
| Delete issue | DELETE | `/rest/api/2/issue/{KEY}` |
| Search (JQL) | GET | `/rest/api/2/search?jql={JQL}` |
| Add comment | POST | `/rest/api/2/issue/{KEY}/comment` |
| Get transitions | GET | `/rest/api/2/issue/{KEY}/transitions` |
| Do transition | POST | `/rest/api/2/issue/{KEY}/transitions` |
| Get project info | GET | `/rest/api/2/project/{KEY}` |
| List projects | GET | `/rest/api/2/project` |
| List priorities | GET | `/rest/api/2/priority` |

## Create Issue

```bash
curl -s -k -X POST "$JIRA_URL/rest/api/2/issue" \
  -H "Authorization: Bearer $JIRA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "fields": {
      "project": { "key": "PROJECT_KEY" },
      "summary": "Issue title here",
      "description": "Description in Jira wiki markup",
      "issuetype": { "name": "任务" },
      "priority": { "name": "Medium" }
    }
  }'
```

**Required fields**: project, summary, issuetype.
**Optional**: description, priority, assignee, labels, components.

## Update Issue

```bash
curl -s -k -X PUT "$JIRA_URL/rest/api/2/issue/{KEY}" \
  -H "Authorization: Bearer $JIRA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "fields": {
      "description": "Updated description"
    }
  }'
```

## Transition (Change Status)

```bash
# 1. Get available transitions
curl -s -k "$JIRA_URL/rest/api/2/issue/{KEY}/transitions" -H "Authorization: Bearer $JIRA_TOKEN"

# 2. Execute transition
curl -s -k -X POST "$JIRA_URL/rest/api/2/issue/{KEY}/transitions" \
  -H "Authorization: Bearer $JIRA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"transition": {"id": "TRANSITION_ID"}}'
```

## Search (JQL)

```bash
curl -s -k "$JIRA_URL/rest/api/2/search?jql=project=PROJECT_KEY+AND+status!=Terminated+ORDER+BY+created+DESC&maxResults=10" \
  -H "Authorization: Bearer $JIRA_TOKEN"
```

## Description Templates

**建立 issue 前，必須檢查使用者提供的資訊是否滿足該類型模板的必填段落。資訊不足時，以對話方式詢問缺少的內容，收集完整後再建立 issue。**

### 故障（Bug）

必填段落：問題描述、重現步驟、預期行為、實際行為

```
h2. 問題描述
簡述遇到的問題。

h2. 重現步驟
# 步驟一
# 步驟二
# 步驟三

h2. 預期行為
應該發生什麼。

h2. 實際行為
實際發生了什麼。

h2. 影響範圍
受影響的功能、用戶、環境等。

h2. 環境資訊
* *環境*: Dev / Pre / Beta / OL
* *時間*: 首次發生時間
```

### 新功能（New Feature）

必填段落：背景與目的、需求描述、驗收標準

```
h2. 背景與目的
為什麼需要這個功能，要解決什麼問題。

h2. 需求描述
功能的具體需求說明。

h2. 驗收標準
# AC1: ...
# AC2: ...
# AC3: ...

h2. 技術備註
實作方向、相關模組、依賴等。
```

### 改進（Improvement）

必填段落：現況、改進目標、改進方案

```
h2. 現況
目前的行為或狀態。

h2. 改進目標
期望改進後達到的效果。

h2. 改進方案
具體的改進做法。

h2. 驗收標準
# AC1: ...
# AC2: ...
```

### 任務（Task）

必填段落：任務描述、完成條件

```
h2. 任務描述
需要完成的工作內容。

h2. 執行步驟
# 步驟一
# 步驟二
# 步驟三

h2. 完成條件
如何判定此任務已完成。
```

### 計劃（Plan/Epic）

必填段落：目標、範圍

```
h2. 目標
此計劃要達成的整體目標。

h2. 範圍
包含哪些工作項目、不包含什麼。

h2. 子任務拆分
* [KEY-xxx|https://jira.1-pay.co/browse/KEY-xxx] - 子任務描述
* 待建立 - 子任務描述

h2. 里程碑
||階段||目標日期||說明||
|Phase 1|yyyy-MM-dd|說明|
|Phase 2|yyyy-MM-dd|說明|

h2. 風險與依賴
* *風險*: ...
* *依賴*: ...
```

### 子任務（Sub-task）

必填段落：任務描述、完成條件

```
h2. 任務描述
此子任務的具體工作內容。

h2. 完成條件
# 條件一
# 條件二
```

## Project-Specific Templates

### WCHPR 問題回報（Bug）

必填段落：問題描述、重現步驟、預期行為、實際行為、裝置與環境資訊

```
h2. 問題描述
簡述遇到的問題。

h2. 重現步驟
# 步驟一
# 步驟二
# 步驟三

h2. 預期行為
應該發生什麼。

h2. 實際行為
實際發生了什麼。

h2. 裝置與環境資訊
||項目||內容||
|SOC IP| |
|SOC Android OS 版本| |
|金寶微信帳號| |
|金寶 APP 版本| |
|微信 APP 版本| |

h2. 附件
* 截圖：（附上相關截圖）
* 影片：（附上操作錄影）
```

**注意**：WCHPR 問題回報的「裝置與環境資訊」7 個欄位（SOC IP、SOC Android OS 版本、金寶微信帳號、金寶 APP 版本、微信 APP 版本、截圖、影片）全部為必填，缺少任何一項都必須向使用者詢問。

### Interactive Information Gathering

建立 issue 時，依照以下流程：

1. **Pre-flight checks**：Token → 專案 → Issue Type（見上方）
2. 根據 issue type，對照上方模板的必填段落
3. 檢查使用者已提供的資訊，找出缺少的必填段落
4. 若有缺少，以對話方式逐一詢問，例如：
   - 「這是一張故障單，請提供重現步驟」
   - 「預期行為是什麼？」
5. **所有必填段落收集完成後**，組合為 Jira wiki markup 格式，再呼叫 API 建立 issue
6. 選填段落（如環境資訊、技術備註）若使用者未提供，可省略不問

**嚴禁「先開單再補充」**：必填段落未收集完整前，絕對不可建立 issue。不得提供「先建立 issue 之後再更新」的選項。所有必填資訊必須在建立前全部到位。

## Common Issue Types

不同專案的 issue type 可能不同，以下為常見類型供參考。實際可用類型應透過 API 查詢確認。

| Name | Use |
|------|-----|
| 新功能 | New feature |
| 改进 | Improvement |
| 故障 | Bug |
| 任务 | Task |
| 計劃 | Plan/Epic |
| 子任务 | Sub-task |

## Priorities

Highest (1), High (2), Medium (3), Low (4), Lowest (5)

## Markdown to Jira Wiki Markup

**Always convert Markdown to Jira wiki markup before sending to the API.**

### Conversion Rules

| Markdown | Jira Wiki Markup |
|----------|-----------------|
| `# H1` | `h1. H1` |
| `## H2` | `h2. H2` |
| `### H3` | `h3. H3` |
| `**bold**` | `*bold*` |
| `*italic*` | `_italic_` |
| `` `code` `` | `{{code}}` |
| `[text](url)` | `[text\|url]` |
| `![alt](url)` | `!url!` |
| `~~strike~~` | `-strike-` |
| `> quote` | `{quote}text{quote}` |
| `---` | `----` |
| `- item` | `* item` (use `*` for unordered) |
| `1. item` | `# item` (use `#` for ordered) |

### Code Blocks

````markdown
```java
code here
```
````

Converts to:

```
{code:java}
code here
{code}
```

For plain code blocks, use `{code}...{code}` without language.

### Tables

Markdown:
```
| Header1 | Header2 |
|---------|---------|
| cell1   | cell2   |
```

Jira wiki:
```
||Header1||Header2||
|cell1|cell2|
```

- Headers use `||` delimiters
- Data rows use `|` delimiters
- No separator row needed

### Nested Lists

```
* Level 1
** Level 2
*** Level 3
```

Ordered:
```
# Level 1
## Level 2
### Level 3
```

## Common Mistakes

- **Forgetting `-k` flag**: Jira uses self-signed cert, curl fails without `-k`
- **Using Basic instead of Bearer auth**: The current token requires `Bearer` auth
- **Sending Markdown directly**: Always convert to Jira wiki markup first
- **JSON escaping in descriptions**: Use heredoc or write to file first for complex descriptions
- **Not checking project**: Different projects may have different issue types and workflows
- **Assuming issue types**: Always verify available issue types via API for the target project
