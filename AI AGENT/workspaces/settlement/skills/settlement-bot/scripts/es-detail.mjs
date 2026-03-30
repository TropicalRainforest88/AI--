#!/usr/bin/env node
/**
 * 訂單操作腳本（按鈕回調用）
 * 用法: node es-detail.mjs <callback_data> <chat_id>
 *
 * callback_data 格式：
 *   fwd:PAY000...  → 轉發該訂單到 OP 群組
 *   PAY000...      → 查詢該訂單詳情
 */
import "./env.mjs";
import http from "node:http";
import https from "node:https";

const BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const FORWARD_GROUP = parseInt(process.env.TG_FORWARD_GROUP || "0");

function tgRequest(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(`${TG_API}/${method}`);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    }, (res) => {
      let chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { reject(new Error("TG: Invalid JSON")); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

const ES_HOST = process.env.ES_HOST || "localhost";
const ES_PORT = parseInt(process.env.ES_PORT || "9200");
const ES_USER = process.env.ES_USER || "elastic";
const ES_PASS = process.env.ES_PASS || "";
const ES_INDEX_PREFIX = "ph-ol-channel-cn";
const ES_AUTH = Buffer.from(`${ES_USER}:${ES_PASS}`).toString("base64");

function esSearch(indexPattern, query, size = 20) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ size, query });
    const req = http.request({
      hostname: ES_HOST, port: ES_PORT,
      path: `/${indexPattern}/_search`, method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Authorization: `Basic ${ES_AUTH}`,
      },
      timeout: 8000,
    }, (res) => {
      let chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(new Error("ES: Invalid JSON")); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("ES: timeout")); });
    req.write(body);
    req.end();
  });
}

function getESIndices(days = 3) {
  const indices = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const ymd = d.toISOString().slice(0, 10).replace(/-/g, ".");
    indices.push(`${ES_INDEX_PREFIX}-${ymd}`);
  }
  return indices.join(",");
}

const STATUS_MAP = { "00": "成功", "03": "失敗", "11": "系統查核中", "13": "同用戶重複建單", "14": "請求逾時", "15": "商戶API請求失敗", "16": "建單異常", "17": "使用異常銀行區域無法建單", "19": "使用異常地區支行無法建單", "20": "申請提現銀行代碼不存在", "21": "使用異常銀行卡無法建單" };

function formatOrderDetail(o) {
  const status = STATUS_MAP[o.returncode] || o.returncode;
  const rc = o.returncode;
  const ext = o.pay_ext || o.ext_index || {};
  const v = (x) => (x && x !== "null" && x !== "undefined") ? x : null;
  const realName = v(o.pay_name) || v(o.RealName) || v(o.pay_real_user_name) || v(ext.realName) || v(ext.orderRealName) || "N/A";
  const username = v(ext.username) || v(o.username) || "N/A";
  const userid = v(ext.userid) || v(o.userid) || "N/A";
  const lines = [];
  lines.push(o._isWdr ? `提款查詢成功` : `交易查詢成功`);
  lines.push(`🔖 ${o._isWdr ? "提款單號" : "訂單ID"}：${o.merchant_order || "N/A"}`);
  lines.push(`📦 商戶訂單號：${o.orderid || "N/A"}`);
  lines.push(`🏷️ 商戶：${o.memberid || o.member_code || "N/A"}`);
  lines.push(`👤 真實姓名：${realName}`);
  lines.push(`👤 用戶名：${username}`);
  lines.push(`🆔 用戶ID：${userid}`);
  lines.push(`💰 金額：${o.amount || "N/A"}`);
  lines.push(`📅 時間：${o.datetime || "N/A"}`);
  lines.push(`📝 備註：${o.remark || "N/A"}`);
  lines.push(`🔢 狀態碼：${rc}（${status}）`);
  if (o.timeout) lines.push(`⏰ 超時：${o.timeout}`);
  return lines.join("\n");
}

async function findOrder(orderId) {
  const indices = getESIndices(3);
  const isWdr = /^WDR/i.test(orderId);

  let query;
  if (isWdr) {
    query = { bool: { must: [
      { match_phrase: { req_content: "withdraw_order" } },
      { match_phrase: { req_content: orderId } },
    ]}};
  } else {
    // 不限 returncode，取所有相關 hit 以補充欄位
    query = { bool: { must: [
      { match_phrase: { req_content: "merchant_order" } },
      { match_phrase: { req_content: orderId } },
    ]}};
  }

  const res = await esSearch(indices, query, 10);
  const hits = res?.hits?.hits || [];

  if (isWdr) {
    // WDR: 合併多筆 hit
    let merged = null;
    for (const hit of hits) {
      try {
        const o = JSON.parse(hit._source?.req_content || "");
        if (o.withdraw_order !== orderId) continue;
        let respObj = {};
        try { respObj = JSON.parse(hit._source?.resp_content || ""); } catch {}
        const wdrExt = o.wdr_ext || {};
        const normalized = {
          merchant_order: o.withdraw_order,
          orderid: o.orderid || null,
          memberid: o.memberid || null,
          returncode: respObj.returncode || o.returncode || null,
          amount: (o.amount && o.amount !== "0.00") ? o.amount : o.wdr_amount || null,
          datetime: o.datetime || null,
          remark: respObj.message || null,
          pay_name: o.wdr_bankcard?.bank_account_name || null,
          username: wdrExt.username || null,
          userid: wdrExt.userid || o.wdr_userid || null,
          pay_ext: wdrExt,
          _isWdr: true,
        };
        if (merged) {
          for (const k of Object.keys(normalized)) {
            if (k === "pay_ext") continue;
            if (normalized[k] && !merged[k]) merged[k] = normalized[k];
            if (k === "datetime" && normalized[k] && normalized[k] > (merged[k] || "")) merged[k] = normalized[k];
            if (k === "amount" && normalized[k] && normalized[k] !== "0.00" && (!merged[k] || merged[k] === "0.00")) merged[k] = normalized[k];
          }
          if (Object.keys(wdrExt).length > 0 && Object.keys(merged.pay_ext || {}).length === 0) merged.pay_ext = wdrExt;
        } else {
          merged = normalized;
        }
      } catch {}
    }
    return merged;
  }

  // PAY: 原始邏輯
  let order = null;
  for (const hit of hits) {
    try {
      const o = JSON.parse(hit._source?.req_content || "");
      if (o.merchant_order === orderId && o.returncode != null) {
        if (!order || (o.datetime && o.datetime > (order.datetime || ""))) {
          order = o;
        }
      }
    } catch {}
  }
  // 補充：從同訂單的其他 hit 中取得缺失欄位
  if (order) {
    const v = (x) => (x && x !== "null" && x !== "undefined") ? x : null;
    for (const hit of hits) {
      try {
        const o = JSON.parse(hit._source?.req_content || "");
        if (o.merchant_order !== orderId) continue;
        if (!v(order.pay_name)) order.pay_name = v(o.pay_name) || v(o.pay_real_user_name) || order.pay_name;
        if (!v(order.RealName)) order.RealName = v(o.RealName) || order.RealName;
        if (!v(order.pay_real_user_name)) order.pay_real_user_name = v(o.pay_real_user_name) || order.pay_real_user_name;
        if ((!order.amount || order.amount === "0.00") && v(o.amount) && o.amount !== "0.00") order.amount = o.amount;
        if (!order.ext_index && o.ext_index) order.ext_index = o.ext_index;
      } catch {}
    }
  }
  return order;
}

// ========== Main ==========
const callbackData = process.argv[2];
const chatId = process.argv[3];
const queryContext = process.argv[4] || "";  // 原始詢問內容（可選）

if (!callbackData || !chatId) {
  console.log("用法: node es-detail.mjs <callback_data> <chat_id> [詢問內容]");
  process.exit(1);
}

try {
  if (callbackData.startsWith("fwd:")) {
    // ===== 轉發模式 =====
    const orderId = callbackData.slice(4);
    const order = await findOrder(orderId);

    if (order) {
      const detail = formatOrderDetail(order);
      const queryLine = queryContext ? `\n\n🔎 詢問內容：${queryContext}` : "";
      const forwardMsg = `📨 訂單查詢通知\n\n${detail}${queryLine}\n\n⚠️ 用戶查詢此訂單問題，請盡快協助查詢處理`;
      const fwdResult = await tgRequest("sendMessage", { chat_id: FORWARD_GROUP, text: forwardMsg });
      if (fwdResult.ok) {
        await tgRequest("sendMessage", { chat_id: chatId, text: `✅ 訂單 ${orderId} 已轉發至OP群組` });
      } else {
        await tgRequest("sendMessage", { chat_id: chatId, text: `❌ 轉發失敗：${fwdResult.description}` });
      }
    } else {
      await tgRequest("sendMessage", { chat_id: chatId, text: `查無此訂單：${orderId}` });
    }

  } else {
    // ===== 查詢詳情模式 =====
    const orderId = callbackData;
    const order = await findOrder(orderId);

    if (order) {
      const detail = formatOrderDetail(order);
      const rc = order.returncode;
      if (rc === "00") {
        await tgRequest("sendMessage", { chat_id: chatId, text: detail + "\n✅ 此訂單已成功，不進行轉發" });
      } else if (rc === "03") {
        await tgRequest("sendMessage", { chat_id: chatId, text: detail + "\n❌ 此訂單已失敗，不進行轉發，若有其他問題請人工查詢確認" });
      } else {
        // 異常訂單：直接轉發到 OP 群組
        if (FORWARD_GROUP) {
          const queryLine = queryContext ? `\n\n🔎 詢問內容：${queryContext}` : "";
          const forwardMsg = `📨 訂單查詢通知\n\n${detail}${queryLine}\n\n⚠️ 用戶查詢此訂單問題，請盡快協助查詢處理`;
          const fwdResult = await tgRequest("sendMessage", { chat_id: FORWARD_GROUP, text: forwardMsg });
          if (fwdResult.ok) {
            await tgRequest("sendMessage", { chat_id: chatId, text: detail + `\n\n✅ 訂單 ${orderId} 已自動轉發至OP群組` });
          } else {
            await tgRequest("sendMessage", { chat_id: chatId, text: detail + `\n\n❌ 自動轉發失敗：${fwdResult.description}` });
          }
        } else {
          await tgRequest("sendMessage", { chat_id: chatId, text: detail + "\n📢 此訂單為OP渠道訂單" });
        }
      }
      console.log(detail);
    } else {
      await tgRequest("sendMessage", { chat_id: chatId, text: `查無此訂單：${orderId}` });
      console.log(`查無此訂單：${orderId}`);
    }
  }
} catch (e) {
  console.log(`操作失敗：${e.message}`);
  process.exit(1);
}
