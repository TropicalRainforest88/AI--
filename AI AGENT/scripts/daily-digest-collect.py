#!/usr/bin/env python3
"""
daily-digest-collect.py — Data collection and summarization for the daily ops report.

Reads env vars:
  OPENAI_ADMIN_API_KEY  — OpenAI Organization Admin API key
  OPENCLAW_BASE         — OpenClaw base directory (default: ~/.openclaw)
  REPORT_DATE           — Date to report on, YYYY-MM-DD (UTC+8)

Outputs a single JSON object to stdout.
Logs/debug info goes to stderr.
"""

import json
import os
import sys
import glob
import urllib.request
import urllib.parse
from datetime import datetime, timedelta, timezone

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

UTC_PLUS_8 = timezone(timedelta(hours=8))

# Known cron prompt prefixes — sessions starting with these are excluded
CRON_PROMPT_MARKERS = [
    "你是 OpenClaw 每日",
    "Generate the daily Jira report",
    "（低頻兜底檢查）",
    "你是 OpenClaw 每日營運報告助手",
]

TEXT_BUDGET_BYTES = 80_000  # ~20-25K tokens


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def log(msg: str):
    print(msg, file=sys.stderr)


def error_json(msg: str, report_date: str) -> dict:
    return {
        "error": msg,
        "reportDate": report_date,
        "generatedAt": datetime.now(UTC_PLUS_8).isoformat(),
    }


def utc_day_boundaries(date_str: str):
    """Return (start_unix, end_unix) for a UTC day as Unix epoch seconds."""
    day = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    start = day.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=1)
    return int(start.timestamp()), int(end.timestamp())


# ---------------------------------------------------------------------------
# OpenAI Usage API
# ---------------------------------------------------------------------------

def _fetch_paginated(api_key: str, url: str, start_ts: int, end_ts: int) -> list:
    """Fetch paginated OpenAI API results grouped by project_id."""
    all_results = []
    page = None

    while True:
        params = {
            "start_time": str(start_ts),
            "end_time": str(end_ts),
            "group_by": "project_id",
            "limit": "20",
        }
        if page:
            params["page"] = page

        full_url = f"{url}?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(full_url, headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        })

        resp = urllib.request.urlopen(req, timeout=30)
        data = json.loads(resp.read().decode())

        for bucket in data.get("data", []):
            all_results.append(bucket)

        page = data.get("next_page")
        if not page:
            break

    return all_results


def fetch_costs(api_key: str, start_ts: int, end_ts: int) -> dict:
    """Fetch actual costs from /v1/organization/costs. Returns projectId -> costUsd."""
    buckets = _fetch_paginated(api_key, "https://api.openai.com/v1/organization/costs", start_ts, end_ts)
    costs = {}
    for bucket in buckets:
        for result in bucket.get("results", []):
            pid = result.get("project_id", "unknown")
            amt = float(result.get("amount", {}).get("value", 0))
            costs[pid] = costs.get(pid, 0) + amt
    return costs


def fetch_usage_tokens(api_key: str, start_ts: int, end_ts: int) -> dict:
    """Fetch token counts from /v1/organization/usage/completions. Returns projectId -> {input, output}."""
    buckets = _fetch_paginated(api_key, "https://api.openai.com/v1/organization/usage/completions", start_ts, end_ts)
    tokens = {}
    for bucket in buckets:
        for result in bucket.get("results", []):
            pid = result.get("project_id", "unknown")
            if pid not in tokens:
                tokens[pid] = {"inputTokens": 0, "outputTokens": 0}
            tokens[pid]["inputTokens"] += result.get("input_tokens", 0)
            tokens[pid]["outputTokens"] += result.get("output_tokens", 0)
    return tokens


def collect_usage(api_key: str, report_date: str, project_map: dict) -> dict:
    """Collect costs + token usage for report_date and the day before."""
    start_ts, end_ts = utc_day_boundaries(report_date)

    prev_date = (datetime.strptime(report_date, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")
    prev_start, prev_end = utc_day_boundaries(prev_date)

    try:
        costs = fetch_costs(api_key, start_ts, end_ts)
        tokens = fetch_usage_tokens(api_key, start_ts, end_ts)

        # Merge costs and tokens by project
        all_pids = set(costs.keys()) | set(tokens.keys())
        by_project = []
        for pid in all_pids:
            info = project_map.get(pid, {"label": pid, "agents": []})
            t = tokens.get(pid, {"inputTokens": 0, "outputTokens": 0})
            by_project.append({
                "label": info["label"],
                "projectId": pid,
                "agents": info["agents"],
                "inputTokens": t["inputTokens"],
                "outputTokens": t["outputTokens"],
                "costUsd": round(costs.get(pid, 0), 4),
            })
        by_project.sort(key=lambda x: x["costUsd"], reverse=True)
        total = round(sum(p["costUsd"] for p in by_project), 4)
    except Exception as e:
        log(f"Usage API error for {report_date}: {e}")
        return {"error": str(e), "byProject": [], "totalCostUsd": 0, "previousDayCostUsd": 0}

    try:
        prev_costs = fetch_costs(api_key, prev_start, prev_end)
        prev_total = round(sum(prev_costs.values()), 4)
    except Exception as e:
        log(f"Costs API error for previous day: {e}")
        prev_total = 0

    return {
        "byProject": by_project,
        "totalCostUsd": total,
        "previousDayCostUsd": prev_total,
    }


# ---------------------------------------------------------------------------
# Session Scanning
# ---------------------------------------------------------------------------

def parse_jsonl(filepath: str) -> list:
    """Parse a .jsonl file into a list of dicts."""
    entries = []
    with open(filepath, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return entries


def is_cron_session(entries: list) -> bool:
    """Check if a session was generated by a cron job."""
    for entry in entries:
        if entry.get("type") != "message":
            continue
        msg = entry.get("message", {})
        if msg.get("role") != "user":
            continue
        content = msg.get("content", [])
        text = ""
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text += block.get("text", "")
            elif isinstance(block, str):
                text += block
        for marker in CRON_PROMPT_MARKERS:
            if marker in text:
                return True
        return False  # Only check the first user message
    return False


def extract_messages(entries: list) -> list:
    """Extract cleaned message content from session entries."""
    messages = []
    for entry in entries:
        if entry.get("type") != "message":
            continue
        msg = entry.get("message", {})
        role = msg.get("role", "unknown")
        timestamp = entry.get("timestamp", "")
        content_blocks = msg.get("content", [])

        text_parts = []
        for block in content_blocks:
            if isinstance(block, str):
                text_parts.append(block)
                continue
            if not isinstance(block, dict):
                continue

            btype = block.get("type", "")
            if btype == "text":
                text_parts.append(block.get("text", ""))
            elif btype == "tool_use":
                name = block.get("name", "unknown_tool")
                inp = json.dumps(block.get("input", {}), ensure_ascii=False)
                text_parts.append(f"[tool_use: {name}] {inp[:300]}")
            elif btype == "tool_result":
                content = block.get("content", "")
                if isinstance(content, list):
                    content = " ".join(
                        c.get("text", "") for c in content
                        if isinstance(c, dict) and c.get("type") == "text"
                    )
                text_parts.append(f"[tool_result] {str(content)[:500]}")
            # Skip thinking, thinkingSignature, etc.

        combined = "\n".join(text_parts).strip()
        if combined:
            messages.append({"role": role, "text": combined, "timestamp": timestamp})

    return messages


def summarize_session(messages: list) -> tuple:
    """Apply Layer 1+2 summarization. Returns (messages, text_size, truncated)."""
    text_size = sum(len(m["text"].encode("utf-8")) for m in messages)

    if text_size <= 10_000:
        return messages, text_size, False

    if text_size <= 50_000:
        result = []
        for m in messages:
            if m["role"] == "user":
                result.append(m)
            else:
                result.append({**m, "text": m["text"][:1000] + ("..." if len(m["text"]) > 1000 else "")})
        new_size = sum(len(m["text"].encode("utf-8")) for m in result)
        return result, new_size, True

    # Large session: full user msgs, first+last assistant full, middle truncated
    result = []
    assistant_indices = [i for i, m in enumerate(messages) if m["role"] != "user"]
    for i, m in enumerate(messages):
        if m["role"] == "user":
            result.append(m)
        elif i == assistant_indices[0] or i == assistant_indices[-1]:
            result.append(m)
        else:
            result.append({**m, "text": m["text"][:200] + ("..." if len(m["text"]) > 200 else "")})
    new_size = sum(len(m["text"].encode("utf-8")) for m in result)
    return result, new_size, True


def apply_budget(sessions: list) -> list:
    """Layer 3: enforce total text budget across all sessions."""
    total = sum(s["_text_size"] for s in sessions)
    if total <= TEXT_BUDGET_BYTES:
        return sessions

    log(f"Budget exceeded: {total} bytes > {TEXT_BUDGET_BYTES}. Trimming largest sessions.")

    # Sort by size descending for trimming
    sessions.sort(key=lambda s: s["_text_size"], reverse=True)

    for s in sessions:
        if total <= TEXT_BUDGET_BYTES:
            break
        conv = s["conversation"]
        # Keep only first user message and last message
        first_user = next((m for m in conv if m["role"] == "user"), None)
        last_msg = conv[-1] if conv else None
        trimmed = []
        if first_user:
            trimmed.append(first_user)
        if last_msg and last_msg != first_user:
            trimmed.append(last_msg)
        old_size = s["_text_size"]
        new_size = sum(len(m["text"].encode("utf-8")) for m in trimmed)
        s["conversation"] = trimmed
        s["_text_size"] = new_size
        s["truncated"] = True
        total -= (old_size - new_size)

    return sessions


def scan_sessions(base: str, report_date: str) -> list:
    """Scan all agent sessions for the report date."""
    start_ts, end_ts = utc_day_boundaries(report_date)
    agents_dir = os.path.join(base, "agents")

    if not os.path.isdir(agents_dir):
        log(f"Agents directory not found: {agents_dir}")
        return []

    results = []
    pattern = os.path.join(agents_dir, "*", "sessions", "*.jsonl")

    for filepath in glob.glob(pattern):
        parts = filepath.split(os.sep)
        # Extract agent name: .../agents/<agentId>/sessions/<file>.jsonl
        try:
            agents_idx = parts.index("agents")
            agent_id = parts[agents_idx + 1]
        except (ValueError, IndexError):
            continue

        session_id = os.path.basename(filepath).replace(".jsonl", "")

        entries = parse_jsonl(filepath)
        if not entries:
            continue

        # Check if session has any messages within report date
        # Use message timestamps (not session header) to catch long-lived sessions
        has_messages_in_range = False
        for entry in entries:
            if entry.get("type") != "message":
                continue
            ts_str = entry.get("timestamp", "")
            try:
                ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                ts_epoch = int(ts.timestamp())
                if start_ts <= ts_epoch < end_ts:
                    has_messages_in_range = True
                    break
            except (ValueError, TypeError):
                continue
        if not has_messages_in_range:
            continue

        # Exclude cron sessions
        if is_cron_session(entries):
            log(f"  Skipping cron session: {agent_id}/{session_id}")
            continue

        messages = extract_messages(entries)
        if not messages:
            continue

        # Get time range
        timestamps = [m["timestamp"] for m in messages if m.get("timestamp")]
        time_range = [timestamps[0], timestamps[-1]] if timestamps else []

        # Count by role
        msg_count = {"user": 0, "assistant": 0, "toolResult": 0}
        for m in messages:
            if m["role"] == "user":
                msg_count["user"] += 1
            elif m["role"] == "assistant":
                msg_count["assistant"] += 1
            elif m["role"] == "toolResult":
                msg_count["toolResult"] += 1

        # Summarize (Layer 1+2)
        summarized, text_size, truncated = summarize_session(messages)

        # Strip timestamps from conversation output
        conversation = [{"role": m["role"], "text": m["text"]} for m in summarized]

        results.append({
            "agent": agent_id,
            "sessionId": session_id,
            "timeRange": time_range,
            "messageCount": msg_count,
            "truncated": truncated,
            "conversation": conversation,
            "_text_size": text_size,
        })

    # Apply budget (Layer 3)
    results = apply_budget(results)

    # Remove internal _text_size field
    for r in results:
        r.pop("_text_size", None)

    # Sort by time
    results.sort(key=lambda s: s["timeRange"][0] if s["timeRange"] else "")

    return results


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def load_project_map(base: str) -> dict:
    """Load agent-projects.json and build projectId -> {label, agents} map."""
    config_path = os.path.join(base, "config", "agent-projects.json")
    if not os.path.isfile(config_path):
        log(f"Warning: {config_path} not found, usage labels will be raw project IDs")
        return {}

    with open(config_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    pm = {}
    for entry in data.get("projects", []):
        pid = entry["projectId"]
        if pid not in pm:
            pm[pid] = {"label": entry["label"], "agents": []}
        if entry["agent"] not in pm[pid]["agents"]:
            pm[pid]["agents"].append(entry["agent"])
    return pm


def main():
    report_date = os.environ.get("REPORT_DATE", "")
    base = os.environ.get("OPENCLAW_BASE", os.path.expanduser("~/.openclaw"))
    api_key = os.environ.get("OPENAI_ADMIN_API_KEY", "")

    if not report_date:
        print(json.dumps(error_json("REPORT_DATE env var not set", "unknown")))
        sys.exit(0)

    log(f"Collecting data for {report_date} from {base}")

    project_map = load_project_map(base)

    # Collect usage
    if api_key:
        log("Fetching OpenAI usage data...")
        usage = collect_usage(api_key, report_date, project_map)
    else:
        log("Warning: OPENAI_ADMIN_API_KEY not set, skipping usage collection")
        usage = {"error": "OPENAI_ADMIN_API_KEY not set", "byProject": [], "totalCostUsd": 0, "previousDayCostUsd": 0}

    # Scan sessions
    log("Scanning sessions...")
    sessions = scan_sessions(base, report_date)

    # Build session summary
    by_agent = {}
    for s in sessions:
        by_agent[s["agent"]] = by_agent.get(s["agent"], 0) + 1

    output = {
        "reportDate": report_date,
        "generatedAt": datetime.now(UTC_PLUS_8).isoformat(),
        "usage": usage,
        "sessions": sessions,
        "sessionSummary": {
            "totalSessions": len(sessions),
            "byAgent": by_agent,
        },
    }

    print(json.dumps(output, ensure_ascii=False, indent=2))
    log(f"Done. {len(sessions)} sessions collected.")


if __name__ == "__main__":
    main()
