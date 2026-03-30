#!/usr/bin/env node
/**
 * 轉發訂單到 Telegram 群組
 * 用法: node tg-forward.mjs <group_id> <message>
 * 或 pipeline: echo "message" | node tg-forward.mjs <group_id>
 */
import "./env.mjs";
import https from "node:https";

const BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const FORWARD_RULES = {
  PAY: parseInt(process.env.TG_FORWARD_GROUP || "0"),
};

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

const groupId = process.argv[2];
const message = process.argv[3] || await new Promise((resolve) => {
  let data = "";
  process.stdin.on("data", (c) => data += c);
  process.stdin.on("end", () => resolve(data.trim()));
  setTimeout(() => resolve(""), 1000);
});

if (!groupId || !message) {
  console.log(JSON.stringify({ error: "用法: node tg-forward.mjs <group_id> <message>" }));
  process.exit(1);
}

try {
  const res = await tgRequest("sendMessage", { chat_id: Number(groupId), text: message });
  if (res.ok) {
    console.log(JSON.stringify({ ok: true, message: `已轉發至群組 ${groupId}` }));
  } else {
    console.log(JSON.stringify({ ok: false, error: res.description }));
  }
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
}
