/* ============================================================================
   travel-planner 统一后端代理 · Vercel Serverless Function
   ----------------------------------------------------------------------------
   作用：把 API Key 全部收敛到服务端环境变量，前端不再持有任何 Key。

   环境变量（在 Vercel 项目 Settings → Environment Variables 配置）：
     · DASHSCOPE_KEY —— 阿里云百炼（DashScope）API Key
     · AMAP_KEY      —— 高德开放平台「Web 服务」类型 Key

   前端调用方式（一律 POST /api/proxy，靠 type 字段区分目标）：
     { "type": "qwen-text",   "body": { model, messages, ... } }   → 千问文本模型
     { "type": "qwen-image",  "body": { model, messages, ... } }   → 千问视觉模型
     { "type": "amap-search", "path": "place/text", "params": {…} } → 高德 POI 搜索
        （amap 通道向后兼容 "endpoint" 字段，等价于 "path"）

   说明：本函数同时接受「裸兼容格式」——即不带 type 但 body 形如 OpenAI 兼容
   请求体时，默认按 qwen-text 处理；带 type 时以 type 为准。
   ============================================================================ */

const DASHSCOPE_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const AMAP_BASE = "https://restapi.amap.com/v3";

/* 允许转发的高德路径白名单：只放行本项目实际用到的接口，避免代理被当成任意转发器 */
const AMAP_ALLOW_PATHS = new Set([
  "place/text",
  "direction/transit/integrated",
  "direction/driving"
]);

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

/* 前置校验：type 是否合法、Key 是否已配置 */
function validate(type) {
  if (type === "qwen-text" || type === "qwen-image") {
    if (!process.env.DASHSCOPE_KEY) {
      return { ok: false, status: 500, obj: { error: { message: "服务端未配置 DASHSCOPE_KEY" } } };
    }
    return { ok: true };
  }
  if (type === "amap-search") {
    if (!process.env.AMAP_KEY) {
      return { ok: false, status: 500, obj: { error: { message: "服务端未配置 AMAP_KEY" } } };
    }
    return { ok: true };
  }
  return { ok: false, status: 400, obj: { error: { message: "未知的 type：" + type } } };
}

function typeOf(payload) {
  const raw = payload && payload.type;
  if (typeof raw === "string" && raw) return raw;
  /* 裸兼容格式：有 model + messages 视为文本抽取 */
  if (payload && payload.model && payload.messages) return "qwen-text";
  return "";
}

/* ---------------- 千问转发（文本 / 视觉共用同一兼容端点） ---------------- */
async function forwardQwen(payload, res) {
  const body = payload.body && typeof payload.body === "object" ? payload.body : payload;
  const upstream = await fetch(DASHSCOPE_BASE + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + process.env.DASHSCOPE_KEY
    },
    body: JSON.stringify(body)
  });
  const text = await upstream.text();
  res.statusCode = upstream.status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(text);
}

/* ---------------- 高德转发（POI 搜索等，走白名单） ---------------- */
async function forwardAmap(payload, res) {
  const path = String((payload && (payload.path || payload.endpoint)) || "place/text").replace(/^\/+/, "");
  if (!AMAP_ALLOW_PATHS.has(path)) {
    return json(res, 400, { error: { message: "不允许的高德接口：" + path } });
  }
  const params = (payload && payload.params && typeof payload.params === "object") ? payload.params : {};
  const qs = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null)
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(String(params[k])))
    .join("&");
  const url = AMAP_BASE + "/" + path + "?key=" + encodeURIComponent(process.env.AMAP_KEY) + "&output=json" + (qs ? "&" + qs : "");

  const upstream = await fetch(url, { method: "GET" });
  const text = await upstream.text();
  res.statusCode = upstream.status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(text);
}

/* ---------------- 入口 ---------------- */
export default async function handler(req, res) {
  setCors(res);

  /* 预检请求直接放行（浏览器跨域时先发 OPTIONS） */
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") {
    return json(res, 405, { error: { message: "仅支持 POST（CORS 预检可用 OPTIONS）" } });
  }

  /* Vercel 一般已解析 req.body；若为字符串则自行 JSON.parse 兜底 */
  let payload = req.body;
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch (e) { payload = null; }
  }
  if (!payload || typeof payload !== "object") {
    return json(res, 400, { error: { message: "请求体必须是 JSON 对象" } });
  }

  const type = typeOf(payload);
  const gate = validate(type);
  if (!gate.ok) return json(res, gate.status, gate.obj);

  try {
    if (type === "qwen-text" || type === "qwen-image") {
      return await forwardQwen(payload, res);
    }
    return await forwardAmap(payload, res);
  } catch (e) {
    return json(res, 502, { error: { message: "上游请求失败：" + (e && e.message ? e.message : String(e)) } });
  }
}
