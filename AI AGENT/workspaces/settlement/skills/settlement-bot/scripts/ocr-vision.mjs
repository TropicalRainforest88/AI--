#!/usr/bin/env node
/**
 * OCR Vision 子任務腳本
 * 用法: node ocr-vision.mjs <image_url_or_path>
 *
 * 1. Google Cloud Vision API — 精準 OCR 文字提取
 * 2. Gemini text-only — 把 OCR 文字解析成結構化 JSON（不傳圖片）
 *
 * 獨立 process，只輸出文字結論到 stdout。
 */
import "./env.mjs";
import https from "node:https";
import http from "node:http";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SA_PATH = process.env.GOOGLE_SA_PATH || resolve(__dirname, "google-sa.json");
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

const imageInput = process.argv[2];
if (!imageInput) {
  console.log(JSON.stringify({ error: "請提供圖片 URL 或本地路徑" }));
  process.exit(1);
}
const isLocalFile = !imageInput.startsWith("http://") && !imageInput.startsWith("https://");

// ========== HTTP helpers ==========

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? https : http;
    mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadBuffer(res.headers.location).then(resolve, reject);
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === "string" ? body : JSON.stringify(body);
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const mod = isHttps ? https : http;
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        ...headers,
      },
      timeout: 30000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(new Error("Invalid JSON response")); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(data);
    req.end();
  });
}

// ========== Google OAuth2 JWT ==========

function base64url(buf) {
  return (typeof buf === "string" ? Buffer.from(buf) : buf)
    .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function createJWT(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-vision",
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  }));
  const sigInput = `${header}.${payload}`;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(sigInput);
  const signature = base64url(sign.sign(sa.private_key));
  return `${sigInput}.${signature}`;
}

async function getAccessToken(sa) {
  const jwt = createJWT(sa);
  const data = await httpsPost(sa.token_uri, `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`, {
    "Content-Type": "application/x-www-form-urlencoded",
  });
  if (data.error) throw new Error(`OAuth error: ${data.error_description || data.error}`);
  return data.access_token;
}

// ========== Google Cloud Vision API ==========

async function visionOCR(imageBase64, accessToken) {
  const result = await httpsPost(
    "https://vision.googleapis.com/v1/images:annotate",
    {
      requests: [{
        image: { content: imageBase64 },
        features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
      }],
    },
    { Authorization: `Bearer ${accessToken}` }
  );
  if (result.error) throw new Error(`Vision API error: ${result.error.message}`);
  const annotation = result.responses?.[0]?.fullTextAnnotation;
  return annotation?.text || "";
}

// ========== Gemini text-only 解析 ==========

async function parseReceiptText(ocrText) {
  if (!GEMINI_API_KEY) {
    // fallback: 回傳原始文字
    return { text: ocrText, isReceipt: true, _raw: true };
  }

  const prompt = `你是交易憑證解析專家。以下是從圖片用 OCR 提取的原始文字。
圖片可能是以下任何一種：
- 銀行電子回單/轉帳憑證
- 支付寶「支付成功」頁面截圖
- 微信支付成功頁面截圖
- 其他第三方支付轉帳成功截圖

請分析並回傳以下 JSON 格式（只回傳 JSON，不加說明文字）：

{
  "text": "交易摘要描述",
  "isReceipt": true,
  "receive_name": "收款人姓名",
  "receive_account": "收款帳號（完整或隱碼原樣）",
  "pay_name": "付款人姓名",
  "pay_account": "付款帳號（完整或隱碼原樣）",
  "amount": 3000.00,
  "transfer_time": "2026-03-24 13:28:00"
}

欄位規則：
- receive_name: 收款方的戶名/賬戶名，只保留中文字和 * 符號。找不到設為 null
- receive_account: 收款方帳號原樣，必須保留所有星號 *（如 ****9773、6222****3183）。找不到設為 null
- pay_name: 付款方的戶名/賬戶名，只保留中文字和 * 符號（如 *紅剛、*燕美）。找不到設為 null
- pay_account: 付款方帳號原樣，必須保留所有星號 *（如 760***@qq.com、138****5678、6228****2773）。找不到設為 null
- amount: 交易金額絕對值，扣除手續費。找不到設為 null
- transfer_time: 格式 YYYY-MM-DD HH:mm:ss。不完整設為 null
- 付款方和收款方是不同的人，分開提取
- 銀行回單/轉帳憑證常見欄位對應：
  - 「付款人」「付款人全稱」「付款方」→ pay_name
  - 「付款账户」「付款帳號」「付款人账号」→ pay_account
  - 「收款人」「收款人全稱」「收款方」→ receive_name
  - 「收款账户」「收款帳號」「收款人账号」→ receive_account
- 支付寶/微信「支付成功」頁面：顯示的姓名（如 *苗春）是收款人，付款人通常不顯示
- 只要包含金額和收款人資訊，就是有效交易憑證（isReceipt: true）
- 只有完全無關交易的內容，才回傳 {"text": "非交易憑證", "isReceipt": false}

OCR 原始文字：
${ocrText}`;

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const data = await httpsPost(geminiUrl, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 2000 },
  });

  if (data.error) throw new Error(`Gemini error: ${data.error.message}`);
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
  return JSON.parse(jsonMatch[1].trim());
}

// ========== Main ==========

try {
  // 1. 讀取圖片
  const imageBuffer = isLocalFile
    ? readFileSync(imageInput)
    : await downloadBuffer(imageInput);
  const imageBase64 = imageBuffer.toString("base64");

  // 2. Google Vision OCR
  const sa = JSON.parse(readFileSync(SA_PATH, "utf8"));
  const accessToken = await getAccessToken(sa);
  const ocrText = await visionOCR(imageBase64, accessToken);

  if (!ocrText.trim()) {
    console.log(JSON.stringify({ error: "OCR 未辨識到文字", isReceipt: false }));
    process.exit(0);
  }

  // 3. Gemini 解析結構化資料（text-only，不傳圖片）
  const result = await parseReceiptText(ocrText);
  if (process.env.OCR_DEBUG === "1") result._ocrText = ocrText;
  console.log(JSON.stringify(result));
} catch (e) {
  console.log(JSON.stringify({ error: e.message }));
  process.exit(1);
}
