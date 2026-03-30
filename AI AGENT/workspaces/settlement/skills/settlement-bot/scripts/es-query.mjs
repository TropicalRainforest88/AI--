#!/usr/bin/env node
/**
 * ES 訂單查詢腳本
 * 用法: node es-query.mjs <keyword> [chat_id]
 * 如果提供 chat_id，直接透過 Telegram Bot API 發送結果給用戶
 * 輸出: JSON 結果到 stdout
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

function tgSend(chatId, text, replyMarkup) {
  const body = { chat_id: chatId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return tgRequest("sendMessage", body);
}

const ES_HOST = process.env.ES_HOST || "localhost";
const ES_PORT = parseInt(process.env.ES_PORT || "9200");
const ES_USER = process.env.ES_USER || "elastic";
const ES_PASS = process.env.ES_PASS || "";
const ES_INDEX_PREFIX = "ph-ol-channel-cn";
const ES_AUTH = Buffer.from(`${ES_USER}:${ES_PASS}`).toString("base64");

function esSearch(indexPattern, query, size = 50) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ size, query, sort: [{ "@timestamp": "desc" }] });
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

// 繁簡對照（姓名常見字）
const pairs = "輝辉,華华,國国,東东,麗丽,義义,書书,學学,風风,雲云,龍龙,鳳凤,軍军,衛卫,達达,運运,進进,連连,遠远,選选,還还,過过,邊边,開开,關关,門门,間间,閃闪,電电,飛飞,馬马,車车,長长,張张,陳陈,鄭郑,鄧邓,劉刘,趙赵,錢钱,孫孙,黃黄,許许,馮冯,蔣蒋,韓韩,楊杨,範范,蘇苏,蕭萧,魏魏,葉叶,鄒邹,盧卢,蘭兰,賈贾,鍾钟,鄔邬,嚴严,閻阎,歐欧,鳳凤,龔龚,關关,溫温,衛卫,鄺邝,廖廖,譚谭,燕燕,駱骆,區区,豐丰,閔闵,齊齐,嶺岭,萬万,億亿,園园,鑫鑫,輝辉,勝胜,傑杰,優优,義义,偉伟,倫伦,軒轩,麟麟,環环,瑋玮,瑤瑶,寶宝,豐丰,慶庆,廣广,禮礼,興兴,發发,順顺,齡龄,壽寿,幗帼,貞贞,瓊琼,鳳凤,嬌娇,儀仪,靈灵,嵐岚,銘铭,釗钊,鋒锋,鑰钥,鑫鑫,鋼钢,銀银,銅铜,鐵铁,鎮镇,鍵键,錦锦,錫锡,鏡镜,閱阅,闊阔,彥彦,堯尧,濤涛,潔洁,瀟潇,漢汉,滿满,潤润,澤泽,測测,減减,準准,況况,決决,凍冻,涼凉,淺浅,溝沟,滅灭,漲涨,沖冲";
const t2s = {};
const s2t = {};
for (const p of pairs.split(",")) {
  if (p.length >= 2) {
    t2s[p[0]] = p[1];
    s2t[p[1]] = p[0];
  }
}
function toSimplified(str) {
  return [...str].map(c => t2s[c] || c).join("");
}
function toTraditional(str) {
  return [...str].map(c => s2t[c] || c).join("");
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

function isWithin24h(datetimeStr) {
  if (!datetimeStr) return false;
  const orderTime = new Date(datetimeStr.replace(" ", "T") + "+08:00").getTime();
  return (Date.now() - orderTime) < 86400000;
}

function parseRespHits(esResult) {
  const hits = esResult?.hits?.hits || [];
  const merchantOrders = new Set();
  for (const hit of hits) {
    try {
      const resp = JSON.parse(hit._source?.resp_content || "");
      if (resp.merchant_order) merchantOrders.add(resp.merchant_order);
    } catch {}
  }
  return [...merchantOrders];
}

function parseReqHits(esResult) {
  const hits = esResult?.hits?.hits || [];
  const orderMap = new Map();
  for (const hit of hits) {
    try {
      const order = JSON.parse(hit._source?.req_content || "");
      if (order.merchant_order && order.returncode != null) {
        const existing = orderMap.get(order.merchant_order);
        if (!existing || (order.datetime && order.datetime > (existing.datetime || ""))) {
          orderMap.set(order.merchant_order, order);
        }
      } else if (order.withdraw_order) {
        // WDR 提款訂單：合併多筆 hit 資料
        const resp = hit._source?.resp_content || "";
        let respObj = {};
        try { respObj = JSON.parse(resp); } catch {}
        const key = order.withdraw_order;
        const existing = orderMap.get(key);
        const wdrExt = order.wdr_ext || {};
        // 從 orderid 或 resp.orderid 提取時間（格式：T_YYYYMMDDHHmmss...）
        const oid = order.orderid || respObj.orderid || null;
        let extractedTime = order.datetime || null;
        if (!extractedTime && oid) {
          const m = oid.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
          if (m) extractedTime = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
        }
        const normalized = {
          merchant_order: order.withdraw_order,
          orderid: oid,
          memberid: order.memberid || null,
          returncode: respObj.returncode || order.returncode || null,
          amount: (order.amount && order.amount !== "0.00") ? order.amount : order.wdr_amount || null,
          datetime: extractedTime,
          remark: respObj.message || null,
          pay_name: order.wdr_bankcard?.bank_account_name || null,
          username: wdrExt.username || null,
          userid: wdrExt.userid || order.wdr_userid || null,
          pay_ext: wdrExt,
          _isWdr: true,
        };
        if (existing) {
          // 合併：用非空值填補
          for (const k of Object.keys(normalized)) {
            if (k === "pay_ext") continue;
            if (normalized[k] && !existing[k]) existing[k] = normalized[k];
            // datetime 取最新
            if (k === "datetime" && normalized[k] && normalized[k] > (existing[k] || "")) existing[k] = normalized[k];
            // amount 取非零
            if (k === "amount" && normalized[k] && normalized[k] !== "0.00" && (!existing[k] || existing[k] === "0.00")) existing[k] = normalized[k];
          }
          // 合併 pay_ext
          if (Object.keys(wdrExt).length > 0 && Object.keys(existing.pay_ext || {}).length === 0) {
            existing.pay_ext = wdrExt;
          }
        } else {
          orderMap.set(key, normalized);
        }
      }
    } catch {}
  }
  // 補充：從同訂單的其他 hit 中取得缺失欄位（pay_name, RealName, amount 等）
  const v = (x) => (x && x !== "null" && x !== "undefined") ? x : null;
  for (const hit of hits) {
    try {
      const o = JSON.parse(hit._source?.req_content || "");
      const key = o.merchant_order;
      if (!key || !orderMap.has(key)) continue;
      const existing = orderMap.get(key);
      // 補 pay_name
      if (!v(existing.pay_name)) {
        existing.pay_name = v(o.pay_name) || v(o.pay_real_user_name) || existing.pay_name;
      }
      // 補 RealName
      if (!v(existing.RealName)) {
        existing.RealName = v(o.RealName) || existing.RealName;
      }
      // 補 pay_real_user_name
      if (!v(existing.pay_real_user_name)) {
        existing.pay_real_user_name = v(o.pay_real_user_name) || existing.pay_real_user_name;
      }
      // 補 amount（取非零值）
      const isZero = (a) => !a || a === "0.00" || a === "0" || a === 0 || parseFloat(a) === 0;
      if (isZero(existing.amount) && v(o.amount) && !isZero(o.amount)) {
        existing.amount = o.amount;
      }
      // 補 ext_index
      if (!existing.ext_index && o.ext_index) {
        existing.ext_index = o.ext_index;
      }
    } catch {}
  }
  return [...orderMap.values()];
}

async function crossQueryOrders(merchantOrders, indices) {
  // 並行查詢所有 merchant_order，大幅加速
  const results = await Promise.allSettled(
    merchantOrders.map(mo =>
      esSearch(indices, {
        bool: {
          must: [
            { match_phrase: { req_content: "merchant_order" } },
            { match_phrase: { req_content: "returncode" } },
            { match_phrase: { req_content: mo } },
          ]
        }
      }, 20).then(res => {
        const orders = parseReqHits(res).filter(o => o.merchant_order === mo);
        if (orders.length > 0) {
          const latest = orders[0];
          if (latest.returncode !== "00" && latest.returncode !== "03" && isWithin24h(latest.datetime)) {
            return latest;
          }
        }
        return null;
      })
    )
  );
  return results
    .filter(r => r.status === "fulfilled" && r.value)
    .map(r => r.value);
}

// 對每個 merchant_order 查詢最新狀態（交叉驗證）+ 補充欄位
async function refreshOrderStatus(orders, indices) {
  const v = (x) => (x && x !== "null" && x !== "undefined") ? x : null;
  const isZeroAmount = (a) => !a || a === "0.00" || a === "0" || a === 0 || parseFloat(a) === 0;
  const results = await Promise.allSettled(
    orders.map(o =>
      // 查所有包含此 merchant_order 的 hit（req_content 或 resp_content），一次取完
      esSearch(indices, {
        bool: {
          should: [
            { match_phrase: { req_content: o.merchant_order } },
            { match_phrase: { resp_content: o.merchant_order } },
          ],
          minimum_should_match: 1
        }
      }, 30).then(res => {
        const hits = res?.hits?.hits || [];
        // 先找有 returncode 的 hit 取最新狀態
        let latest = null;
        for (const hit of hits) {
          try {
            const parsed = JSON.parse(hit._source?.req_content || "");
            if (parsed.merchant_order === o.merchant_order && parsed.returncode != null) {
              if (!latest || (parsed.datetime && parsed.datetime > (latest.datetime || ""))) {
                latest = parsed;
              }
            }
          } catch {}
        }
        if (!latest) latest = o;
        // 從所有 hit 的 req_content + resp_content 補充缺失欄位
        for (const hit of hits) {
          // 補充 req_content 欄位
          try {
            const parsed = JSON.parse(hit._source?.req_content || "");
            if (parsed.merchant_order !== o.merchant_order) { /* skip */ } else {
              if (!v(latest.pay_name)) latest.pay_name = v(parsed.pay_name) || v(parsed.pay_real_user_name) || latest.pay_name;
              if (!v(latest.RealName)) latest.RealName = v(parsed.RealName) || latest.RealName;
              if (!v(latest.pay_real_user_name)) latest.pay_real_user_name = v(parsed.pay_real_user_name) || latest.pay_real_user_name;
              if (isZeroAmount(latest.amount) && v(parsed.amount) && !isZeroAmount(parsed.amount)) latest.amount = parsed.amount;
              if (!latest.ext_index && parsed.ext_index) latest.ext_index = parsed.ext_index;
            }
          } catch {}
          // 補充 resp_content 欄位（amount、pay_name 等可能在 resp_content）
          try {
            const resp = JSON.parse(hit._source?.resp_content || "");
            if (resp.merchant_order === o.merchant_order || resp.order_id === o.merchant_order) {
              if (isZeroAmount(latest.amount) && v(resp.amount) && !isZeroAmount(resp.amount)) latest.amount = resp.amount;
              if (!v(latest.pay_name)) latest.pay_name = v(resp.pay_name) || v(resp.RealName) || latest.pay_name;
              if (!v(latest.RealName)) latest.RealName = v(resp.RealName) || latest.RealName;
            }
          } catch {}
        }
        return latest;
      })
    )
  );
  return results.map((r, i) => r.status === "fulfilled" ? r.value : orders[i]);
}

async function queryTransaction(keyword) {
  const indices = getESIndices(3);
  let matches = [];
  let wdrMatches = []; // WDR 提款單獨立追蹤，不阻擋 PAY 搜尋
  let ocrImageUrl = null;

  const respBase = [
    { match_phrase: { resp_content: "merchant_order" } },
    { match_phrase: { resp_content: "returncode" } },
  ];
  const reqBase = [
    { match_phrase: { req_content: "merchant_order" } },
    { match_phrase: { req_content: "returncode" } },
  ];

  const isWdrQuery = /^WDR/i.test(keyword);

  // 繁簡體關鍵字（中文姓名可能繁簡不同）
  const kwSimplified = toSimplified(keyword);
  const kwTraditional = toTraditional(keyword);
  const keywords = [...new Set([keyword, kwSimplified, kwTraditional])];
  // 產生 should 條件：搜尋所有繁簡版本
  const kwShould = (field) => keywords.map(kw => ({ match_phrase: { [field]: kw } }));

  // 1: 直接查 req_content（訂單號、userid、username 等）
  try {
    let query;
    if (isWdrQuery) {
      query = { bool: { must: [
        { match_phrase: { req_content: "withdraw_order" } },
        { bool: { should: kwShould("req_content"), minimum_should_match: 1 } },
      ]}};
    } else {
      query = { bool: { must: [...reqBase, { bool: { should: kwShould("req_content"), minimum_should_match: 1 } }] } };
    }
    const res = await esSearch(indices, query, 50);
    const orders = parseReqHits(res);
    if (orders.length > 0) {
      if (isWdrQuery) {
        matches = orders; // WDR 訂單不需要交叉驗證
      } else {
        // 交叉驗證：對每個訂單重新查詢最新狀態
        matches = await refreshOrderStatus(orders, indices);
      }
    }
  } catch (e) {
    console.error("ES query (req direct) error:", e.message);
  }

  // 1.5: 同時搜尋 WDR 提款單（放到 wdrMatches，不阻擋後續 PAY 搜尋）
  if (!isWdrQuery) {
    try {
      const wdrRes = await esSearch(indices, {
        bool: { must: [
          { match_phrase: { req_content: "withdraw_order" } },
          { bool: { should: kwShould("req_content"), minimum_should_match: 1 } },
        ]}
      }, 20);
      const wdrOrders = parseReqHits(wdrRes);
      if (wdrOrders.length > 0) {
        wdrMatches = wdrOrders;
      }
    } catch (e) {
      console.error("ES query (wdr supplement) error:", e.message);
    }
  }

  // 2: 交叉查詢 resp_content → merchant_orders → req_content
  if (matches.length === 0) {
    try {
      const res = await esSearch(indices, {
        bool: { must: [...respBase, { bool: { should: kwShould("resp_content"), minimum_should_match: 1 } }] }
      }, 20);
      const merchantOrders = parseRespHits(res);
      if (merchantOrders.length > 0) {
        matches = await crossQueryOrders(merchantOrders, indices);
      }
    } catch (e) {
      console.error("ES query (resp cross) error:", e.message);
    }
  }

  // 3: 寬鬆搜尋（商戶訂單號等不含 merchant_order 欄位的資料）
  if (matches.length === 0) {
    try {
      // 搜尋 req_content 或 resp_content 中包含 keyword 的任何記錄
      const res = await esSearch(indices, {
        bool: { should: [
          ...kwShould("req_content"),
          ...kwShould("resp_content"),
        ], minimum_should_match: 1 }
      }, 20);
      const hits = res?.hits?.hits || [];
      // 從 hits 中提取 withdraw_order 或 merchant_order
      const orderIds = new Set();
      for (const hit of hits) {
        for (const field of ["req_content", "resp_content"]) {
          try {
            const obj = JSON.parse(hit._source?.[field] || "");
            if (obj.withdraw_order) orderIds.add(obj.withdraw_order);
            if (obj.merchant_order) orderIds.add(obj.merchant_order);
          } catch {}
        }
      }
      // 用找到的訂單號重新查詢完整資料
      for (const oid of orderIds) {
        if (/^WDR/i.test(oid)) {
          const wdrRes = await esSearch(indices, {
            bool: { must: [
              { match_phrase: { req_content: "withdraw_order" } },
              { match_phrase: { req_content: oid } },
            ]}
          }, 20);
          const wdrOrders = parseReqHits(wdrRes);
          matches.push(...wdrOrders);
        } else {
          const payRes = await esSearch(indices, {
            bool: { must: [...reqBase, { match_phrase: { req_content: oid } }] }
          }, 20);
          const payOrders = parseReqHits(payRes);
          if (payOrders.length > 0) {
            const refreshed = await refreshOrderStatus(payOrders, indices);
            matches.push(...refreshed);
          }
        }
      }
    } catch (e) {
      console.error("ES query (broad) error:", e.message);
    }
  }

  // 4: 搜尋 message 欄位（OCR 結果記錄包含姓名和訂單號）
  if (matches.length === 0) {
    try {
      const res = await esSearch(indices, {
        bool: { must: [
          { bool: { should: kwShould("message"), minimum_should_match: 1 } },
        ]}
      }, 20);
      const hits = res?.hits?.hits || [];
      const orderIds = new Set();
      for (const hit of hits) {
        const msg = hit._source?.message || "";
        // 支援多種格式：order=PAY..., order id = PAY..., order_id=PAY...
        const patterns = [
          /order\s*(?:id\s*)?[=:]\s*(PAY\w+|WDR\w+)/gi,
        ];
        for (const pat of patterns) {
          let m;
          while ((m = pat.exec(msg)) !== null) {
            orderIds.add(m[1]);
          }
        }
      }
      // 從 OCR API 記錄中提取圖片 URL（req_content 有 imageUrl，resp_content 有姓名）
      if (!ocrImageUrl) {
        try {
          const imgRes = await esSearch(indices, {
            bool: { must: [
              { match_phrase: { req_content: "imageUrl" } },
              { bool: { should: kwShould("resp_content"), minimum_should_match: 1 } },
            ]}
          }, 1);
          const imgHit = imgRes?.hits?.hits?.[0];
          if (imgHit) {
            const rc = JSON.parse(imgHit._source?.req_content || "{}");
            if (rc.imageUrl) ocrImageUrl = rc.imageUrl.replace(/\\\//g, '/');
          }
        } catch {}
      }
      for (const oid of orderIds) {
        if (/^WDR/i.test(oid)) {
          const wdrRes = await esSearch(indices, {
            bool: { must: [
              { match_phrase: { req_content: "withdraw_order" } },
              { match_phrase: { req_content: oid } },
            ]}
          }, 20);
          matches.push(...parseReqHits(wdrRes));
        } else {
          const payRes = await esSearch(indices, {
            bool: { must: [...reqBase, { match_phrase: { req_content: oid } }] }
          }, 20);
          const payOrders = parseReqHits(payRes);
          if (payOrders.length > 0) {
            matches.push(...(await refreshOrderStatus(payOrders, indices)));
          }
        }
      }
    } catch (e) {
      console.error("ES query (ocr message) error:", e.message);
    }
  }

  // 合併 WDR 提款單（去重）
  if (wdrMatches.length > 0) {
    const existingIds = new Set(matches.map(m => m.merchant_order));
    for (const wo of wdrMatches) {
      if (!existingIds.has(wo.merchant_order)) {
        matches.push(wo);
      }
    }
  }

  // 過濾：排除關鍵字只出現在代理鏈（agent）中的訂單
  // 只對非訂單號查詢生效（訂單號查詢是精確匹配，不受影響）
  const isOrderId = /^(PAY|WDR)\d{10,}/i.test(keyword) || /^[A-Za-z0-9]+_\d+/.test(keyword);
  if (!isOrderId && matches.length > 0) {
    const kwLower = keyword.toLowerCase();
    matches = matches.filter(o => {
      const ext = o.pay_ext || o.ext_index || {};
      // 檢查主欄位是否包含關鍵字
      const mainFields = [
        o.merchant_order, o.orderid, o.memberid, o.member_code,
        o.pay_name, o.RealName, o.pay_real_user_name,
        o.username, o.userid,
        ext.username, ext.userid, ext.realName, ext.orderRealName,
      ];
      const matchMain = mainFields.some(f =>
        f && String(f).toLowerCase().includes(kwLower)
      );
      if (matchMain) return true;
      // 如果只在 agent 欄位中出現，排除
      const agentField = typeof ext.agent === "string" ? ext.agent : "";
      if (agentField.toLowerCase().includes(kwLower)) return false;
      // 都沒匹配到（可能在其他欄位），保留
      return true;
    });
  }

  return { matches, ocrImageUrl };
}

// ========== 格式化結果 ==========
const STATUS_MAP = { "00": "成功", "03": "失敗", "04": "簽名失敗", "11": "系統查核中", "13": "同用戶重複建單", "14": "請求逾時", "15": "商戶API請求失敗", "16": "建單異常", "17": "使用異常銀行區域無法建單", "19": "使用異常地區支行無法建單", "20": "申請提現銀行代碼不存在", "21": "使用異常銀行卡無法建單" };

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
  const amt = o.amount ? parseFloat(o.amount) : NaN;
  lines.push(`💰 金額：${isNaN(amt) ? "N/A" : amt % 1 === 0 ? amt.toString() : amt.toFixed(2)}`);
  lines.push(`📅 時間：${o.datetime || "N/A"}`);
  lines.push(`📝 備註：${o.remark || "N/A"}`);
  lines.push(`🔢 狀態碼：${rc}（${status}）`);
  if (o.timeout) lines.push(`⏰ 超時：${o.timeout}`);
  if (rc === "00") lines.push(`✅ 此訂單已成功，不進行轉發`);
  else if (rc === "03") lines.push(`❌ 此訂單已失敗，不進行轉發，若有其他問題請人工查詢確認`);
  else lines.push(`📢 此訂單為OP渠道訂單，將進行轉發至OP群組`);
  return lines.join("\n");
}

function formatSummaryForButtons(sorted) {
  const abnormal = sorted.filter(o => o.returncode !== "00" && o.returncode !== "03");
  const lines = [];
  if (abnormal.length > 0) {
    lines.push(`🔍 查詢到 ${sorted.length} 筆訂單，其中 ${abnormal.length} 筆異常：`);
  } else {
    lines.push(`🔍 查詢到 ${sorted.length} 筆訂單：`);
  }
  lines.push("");
  const display = sorted.slice(0, 8);
  for (let i = 0; i < display.length; i++) {
    const o = display[i];
    const status = STATUS_MAP[o.returncode] || o.returncode;
    const shortId = (o.merchant_order || "").slice(-10);
    const icon = o.returncode === "00" ? "✅" : o.returncode === "03" ? "❌" : "⚠️";
    lines.push(`${icon} #${i + 1} ...${shortId} | ${status} | ${o.datetime?.slice(5, 16) || "N/A"}`);
  }
  lines.push("");
  lines.push("👇 點擊按鈕查看訂單詳情：");
  return lines.join("\n");
}

function buildInlineKeyboard(sorted) {
  const display = sorted.slice(0, 8);
  // 每行 2 個按鈕
  const rows = [];
  for (let i = 0; i < display.length; i += 2) {
    const row = [];
    for (let j = i; j < Math.min(i + 2, display.length); j++) {
      const o = display[j];
      const shortId = (o.merchant_order || "").slice(-8);
      const icon = o.returncode === "00" ? "✅" : o.returncode === "03" ? "❌" : "⚠️";
      row.push({
        text: `${icon} #${j + 1} ...${shortId}`,
        callback_data: o.merchant_order,
      });
    }
    rows.push(row);
  }
  return { inline_keyboard: rows };
}

// ========== Main ==========
const rawInput = process.argv[2];
const chatId = process.argv[3];
if (!rawInput) {
  console.log("請提供查詢關鍵字");
  process.exit(1);
}

// 自動從原始輸入中提取關鍵字，並保留原文作為詢問內容
function extractKeyword(input) {
  // 如果包含查詢動詞，提取其後的關鍵字
  const queryMatch = input.match(/(?:查[詢询]?|找|搜[索尋]?|幫我查[一下]*)\s*[：:]?\s*(.+)/);
  if (queryMatch) {
    // 進一步清理：移除「用戶訂單」「用户订单」等描述詞
    const cleaned = queryMatch[1].replace(/^(?:用[戶户]訂?[單单]|訂?[單单]|一下)\s*/g, '').trim();
    if (cleaned) return cleaned;
  }
  return input.trim();
}

// 清理遮罩名稱：「怡馨(**馨)」→「怡馨」，「王*涛」→「王涛」
function cleanMaskedName(name) {
  // 移除半形和全形括號及其內容（如 (**馨)、（**馨））
  let cleaned = name.replace(/[（(][^)）]*[)）]/g, '').trim();
  // 移除星號
  cleaned = cleaned.replace(/\*/g, '').trim();
  return cleaned || name;
}

let keyword = extractKeyword(rawInput);
const queryContext = rawInput.trim() !== keyword ? rawInput.trim() : keyword;

// 如果關鍵字包含遮罩字元（* 或括號），清理後再查詢
if (/[*（()）]/.test(keyword)) {
  keyword = cleanMaskedName(keyword);
}

try {
  const isOrderIdQuery = /^(PAY|WDR)\d{10,}/i.test(keyword) || /^[A-Za-z0-9]+_\d+/.test(keyword);
  let { matches, ocrImageUrl } = await queryTransaction(keyword);

  // 非訂單號查詢：嚴格過濾，只保留異常訂單
  let allFilteredOut = false;
  if (!isOrderIdQuery) {
    const total = matches.length;
    const abnormalOnly = matches.filter(o => o.returncode !== "00" && o.returncode !== "03");
    if (total > 0 && abnormalOnly.length === 0) {
      // 有訂單但全部成功/失敗：列出每筆單號和狀態
      const statusLines = matches.map(o => {
        const status = o.returncode === "00" ? " ✅ 訂單已成功" : " ❌ 訂單已失敗";
        return `${o.merchant_order}${status}`;
      });
      const msg = `查到 ${total} 筆訂單：\n${statusLines.join("\n")}`;
      console.log(msg);
      allFilteredOut = true;
    }
    matches = abnormalOnly;
  }

  if (allFilteredOut || matches.length === 0) {
    if (!allFilteredOut) {
      const msg = `查無資料，關鍵字：${keyword}`;
      console.log(msg);
    }
  } else {
    const sorted = matches.sort((a, b) => (b.datetime || "").localeCompare(a.datetime || ""));
    const abnormal = sorted.filter(o => o.returncode !== "00" && o.returncode !== "03");
    const display = sorted.slice(0, 5);

    if (sorted.length === 1) {
      // === 單筆訂單：顯示詳情，異常直接轉發 ===
      const o = sorted[0];
      const detail = formatOrderDetail(o);
      const isAbnormal = o.returncode !== "00" && o.returncode !== "03";
      const isPAY = o.merchant_order && /^PAY/i.test(o.merchant_order);
      if (isAbnormal && isPAY && FORWARD_GROUP && chatId) {
        // 單筆 PAY 異常：直接轉發到 OP 群組
        const queryLine = `\n\n🔎 詢問內容：${queryContext}`;
        const forwardMsg = `📨 訂單查詢通知\n\n${detail}${queryLine}\n\n⚠️ 用戶查詢此訂單問題，請盡快協助查詢處理`;
        if (ocrImageUrl) {
          await tgRequest("sendPhoto", { chat_id: FORWARD_GROUP, photo: ocrImageUrl, caption: "🖼️ 用戶提交的銀行回單" });
        }
        const fwdResult = await tgRequest("sendMessage", { chat_id: FORWARD_GROUP, text: forwardMsg });
        if (fwdResult.ok) {
          console.log(detail + `\n\n✅ 訂單 ${o.merchant_order} 已自動轉發至OP群組`);
        } else {
          console.log(detail + `\n\n❌ 自動轉發失敗：${fwdResult.description}`);
        }
      } else {
        console.log(detail);
      }
    } else {
      // === 多筆訂單 ===
      const outputLines = [`🔍 查詢到 ${sorted.length} 筆訂單，顯示最近 ${display.length} 筆：\n`];
      for (const o of display) {
        const detail = formatOrderDetail(o);
        const isAbnormal = o.returncode !== "00" && o.returncode !== "03";
        const isPAY = o.merchant_order && /^PAY/i.test(o.merchant_order);
        if (isAbnormal && isPAY && FORWARD_GROUP && chatId) {
          // PAY 異常訂單：轉發到 OP 群組
          const queryLine = `\n\n🔎 詢問內容：${queryContext}`;
          const forwardMsg = `📨 訂單查詢通知\n\n${detail}${queryLine}\n\n⚠️ 用戶查詢此訂單問題，請盡快協助查詢處理`;
          if (ocrImageUrl) {
            await tgRequest("sendPhoto", { chat_id: FORWARD_GROUP, photo: ocrImageUrl, caption: "🖼️ 用戶提交的銀行回單" });
            ocrImageUrl = null;
          }
          const fwdResult = await tgRequest("sendMessage", { chat_id: FORWARD_GROUP, text: forwardMsg });
          if (fwdResult.ok) {
            outputLines.push(detail + `\n\n✅ 訂單 ${o.merchant_order} 已自動轉發至OP群組\n`);
          } else {
            outputLines.push(detail + `\n\n❌ 自動轉發失敗：${fwdResult.description}\n`);
          }
        } else if (isAbnormal && o.merchant_order && chatId) {
          // 非 PAY 異常訂單：需要按鈕，必須用 tgSend
          const keyboard = {
            inline_keyboard: [[
              { text: "📨 轉發此訂單至OP群組", callback_data: `fwd:${o.merchant_order}` }
            ]]
          };
          await tgSend(chatId, detail, keyboard);
          // 有按鈕的不加入 stdout（已經透過 tgSend 發了）
        } else {
          outputLines.push(detail + "\n");
        }
      }
      if (sorted.length > 5) {
        outputLines.push(`（共 ${sorted.length} 筆，僅顯示最近 5 筆）`);
      }
      console.log(outputLines.join("\n"));
    }
  }
} catch (e) {
  console.log(`查詢失敗：${e.message}`);
  process.exit(1);
}
