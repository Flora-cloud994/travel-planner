/* ============================================================================
   travel-planner 统一后端代理 · 腾讯云 EdgeOne Pages Edge Function
   ----------------------------------------------------------------------------
   路由：functions/api/proxy.js → /api/proxy
   形态：Web 标准 Request / Response（Edge Function 运行时，非 Node 运行时）

   ⚠️ 与 Vercel 版（api/proxy.mjs）的关键差异（迁移时务必知悉）：
     ① 入口签名：Vercel 是 `export default handler(req, res)`（Node 风格，
        手动 res.statusCode/res.end）；本版是 `export function onRequest(context)`
        返回 Web 标准 `Response` 对象。
     ② 环境变量：Vercel 读 `process.env.X`；Edge Function **没有 process.env**，
        必须从 `context.env.X` 读（run_worker_first 与 env 注入由平台完成）。
     ③ 请求体：Web 标准下不能像 Vercel 那样直接拿 req.body（已解析对象），
        必须 `await request.text()` 再 JSON.parse。
     ④ 二进制/流式：上游响应统一走 `upstream.text()` 透传，
        保持与 Vercel 版完全一致的语义（前端不感知差异）。

   环境变量（在 EdgeOne Pages 控制台 → 项目设置 → 环境变量 配置）：
     · DEEPSEEK_KEY  —— DeepSeek 开放平台 API Key（文本识别，必填）
     · ZHIPU_KEY     —— 智谱 AI API Key（截图识别，推荐）
                        或 DASHSCOPE_KEY —— 阿里云百炼 API Key（截图识别，备选）
                        两者任配其一即可；都未配置时该功能自动禁用（文本识别不受影响）。
                        优先级：ZHIPU_KEY > DASHSCOPE_KEY。
     · AMAP_KEY      —— 高德开放平台「Web 服务」类型 Key
     · TMAP_KEY      —— 腾讯位置服务 Key（可选，用于到达点搜索）

   前端调用方式与 Vercel 版完全一致（一律 POST /api/proxy，靠 type 区分）：
     { "type": "qwen-text",   "body": { model, messages, ... } }   → 文本模型
     { "type": "qwen-image",  "body": { model, messages, ... } }   → 视觉模型
     { "type": "amap-search", "path": "place/text", "params": {…} } → 高德 POI
     { "type": "tmap-search", "params": "keyword=…&boundary=…" }   → 腾讯地图 POI
   兼容：不带 type 但 body 形如 OpenAI 请求体时，默认按 qwen-text 处理。
   ============================================================================ */

/* DeepSeek：文本识别（OpenAI 兼容端点） */
const DEEPSEEK_BASE = "https://api.deepseek.com";
const DEEPSEEK_MODEL = "deepseek-chat";

/* 智谱 AI：视觉（截图）识别首选。端点与请求格式同为 OpenAI 兼容。 */
const ZHIPU_BASE = "https://open.bigmodel.cn/api/paas/v4";
const ZHIPU_VISION_MODEL = "glm-4v-plus";

/* 阿里云百炼：视觉（截图）识别备选 —— 仅当未配 ZHIPU_KEY 且配了 DASHSCOPE_KEY 时启用 */
const DASHSCOPE_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DASHSCOPE_VISION_MODEL = "qwen-vl-plus";

const AMAP_BASE = "https://restapi.amap.com/v3";
const TMAP_BASE = "https://apis.map.qq.com/ws/place/v1/search";

/* 允许转发的高德路径白名单：只放行本项目实际用到的接口，避免代理被当成任意转发器 */
const AMAP_ALLOW_PATHS = new Set([
  "place/text",
  "direction/transit/integrated",
  "direction/driving"
]);

/* 腾讯地图查询串白名单：只放行本项目用到的参数名，其余一律丢弃
   （防止前端被篡改成任意查询 / 注入 &key= 之类） */
const TMAP_ALLOW_PARAMS = new Set(["keyword", "boundary", "page_size", "page_index"]);

/* 高德「由服务端保留」的参数名：这些一律不接受前端传入，
   避免前端塞 key=xxx 覆盖服务端 Key（参数注入）。
   注意：高德部分接口确实用 key 作为业务参数（如某些位置描述），
   但本项目用到的 place/text 与 direction/* 均不需要，故一律屏蔽。 */
const AMAP_RESERVED_PARAMS = new Set(["key", "output"]);

/* 统一 CORS + JSON 响应头 */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

/* Web 标准响应构造（替代 Vercel 版的 json(res, status, obj)） */
function json(status, obj, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: Object.assign(
      {},
      CORS_HEADERS,
      { "Content-Type": "application/json; charset=utf-8" },
      extraHeaders || {}
    )
  });
}

/* 透传上游响应：保持状态码与响应体原样，附加 CORS 头 */
function passthrough(status, text) {
  return new Response(text, {
    status: status,
    headers: Object.assign({}, CORS_HEADERS, { "Content-Type": "application/json; charset=utf-8" })
  });
}

/* 视觉通道选择：智谱优先，其次千问；都没配则返回 null（表示功能未启用）。
   两家均为 OpenAI 兼容的多模态格式，故前端请求体可直接复用。
   ⚠️ 环境变量从 env 参数读取（Edge Function 无 process.env）。 */
function pickVisionChannel(env) {
  if (env.ZHIPU_KEY) {
    return { name: "zhipu", base: ZHIPU_BASE, model: ZHIPU_VISION_MODEL, key: env.ZHIPU_KEY };
  }
  if (env.DASHSCOPE_KEY) {
    return { name: "dashscope", base: DASHSCOPE_BASE, model: DASHSCOPE_VISION_MODEL, key: env.DASHSCOPE_KEY };
  }
  return null;
}

/* 前置校验：type 是否合法、Key 是否已配置 */
function validate(type, env) {
  if (type === "qwen-text") {
    if (!env.DEEPSEEK_KEY) {
      return { ok: false, status: 500, obj: { error: { message: "服务端未配置 DEEPSEEK_KEY" } } };
    }
    return { ok: true };
  }
  if (type === "qwen-image") {
    /* 视觉识别需智谱或千问任一 Key；都未配时明确告知「截图功能不可用」，
       而不是笼统报错 —— 文本识别不依赖它。 */
    if (!pickVisionChannel(env)) {
      return {
        ok: false,
        status: 503,
        obj: {
          error: {
            message: "服务端未配置 ZHIPU_KEY 或 DASHSCOPE_KEY，截图识别功能不可用（文本识别不受影响）",
            code: "vision_unavailable"
          }
        }
      };
    }
    return { ok: true };
  }
  if (type === "amap-search") {
    if (!env.AMAP_KEY) {
      return { ok: false, status: 500, obj: { error: { message: "服务端未配置 AMAP_KEY" } } };
    }
    return { ok: true };
  }
  if (type === "tmap-search") {
    /* 腾讯通道是**可选的**：不配 TMAP_KEY 时不报错，由 forwardTmap 返回空结果，
       前端「到达点搜索」自然无结果，但页面不会崩。 */
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

/* ---------------- 文本转发（DeepSeek，OpenAI 兼容端点） ----------------
   前端传的 body 是标准 OpenAI 兼容请求体。为保证「换模型只改服务端」，
   这里强制把 model 重写为 DEEPSEEK_MODEL，前端传的 model 一律忽略。 */
async function forwardDeepSeek(payload, env) {
  const raw = payload.body && typeof payload.body === "object" ? payload.body : payload;
  const body = Object.assign({}, raw, { model: DEEPSEEK_MODEL });
  const upstream = await fetch(DEEPSEEK_BASE + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + env.DEEPSEEK_KEY
    },
    body: JSON.stringify(body)
  });
  const text = await upstream.text();
  return passthrough(upstream.status, text);
}

/* ---------------- 视觉转发（截图识别） ----------------
   上游按 pickVisionChannel() 选择：智谱 GLM-4V 或 千问 VL。
   两家请求格式一致（OpenAI 兼容多模态），故这里统一处理，
   并把 model 重写为所选通道的模型名（前端传的 model 不生效）。 */
async function forwardVision(payload, env) {
  const ch = pickVisionChannel(env);
  if (!ch) {
    /* 双保险：validate 已拦过，这里再兜一次 */
    return json(503, {
      error: { message: "服务端未配置 ZHIPU_KEY 或 DASHSCOPE_KEY，截图识别功能不可用", code: "vision_unavailable" }
    });
  }
  const raw = payload.body && typeof payload.body === "object" ? payload.body : payload;
  const body = Object.assign({}, raw, { model: ch.model });
  const upstream = await fetch(ch.base + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + ch.key
    },
    body: JSON.stringify(body)
  });
  const text = await upstream.text();
  return passthrough(upstream.status, text);
}

/* ---------------- 高德转发（POI 搜索等，走白名单） ---------------- */
async function forwardAmap(payload, env) {
  const path = String((payload && (payload.path || payload.endpoint)) || "place/text").replace(/^\/+/, "");
  if (!AMAP_ALLOW_PATHS.has(path)) {
    return json(400, { error: { message: "不允许的高德接口：" + path } });
  }
  const params = (payload && payload.params && typeof payload.params === "object") ? payload.params : {};
  const qs = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null)
    .filter((k) => !AMAP_RESERVED_PARAMS.has(k))
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(String(params[k])))
    .join("&");
  const url = AMAP_BASE + "/" + path + "?key=" + encodeURIComponent(env.AMAP_KEY) + "&output=json" + (qs ? "&" + qs : "");

  const upstream = await fetch(url, { method: "GET" });
  const text = await upstream.text();
  return passthrough(upstream.status, text);
}

/* ---------------- 腾讯地图转发（到达点搜索，参数走白名单；可选通道） ----------------
   未配置 TMAP_KEY 时**不报错**，直接返回一个空结果集（status:0 + 无 data），
   前端「到达点搜索」表现为「未找到」而不是页面报错。 */
async function forwardTmap(payload, env) {
  if (!env.TMAP_KEY) {
    return json(200, { status: 0, message: "服务端未配置 TMAP_KEY（腾讯通道已停用）", data: [] });
  }
  /* params 是前端拼好的查询串（keyword=…&boundary=…）；这里逐项过滤，
     只保留白名单内的键，并重新编码，避免被塞入 &key= 之类做参数注入。 */
  const raw = String((payload && payload.params) || "");
  const kept = [];
  raw.split("&").forEach((kv) => {
    if (!kv) return;
    const i = kv.indexOf("=");
    const k = i < 0 ? kv : kv.slice(0, i);
    const v = i < 0 ? "" : kv.slice(i + 1);
    if (!TMAP_ALLOW_PARAMS.has(k)) return;
    kept.push(encodeURIComponent(k) + "=" + encodeURIComponent(decodeURIComponent(v)));
  });
  const qs = kept.join("&");
  const url = TMAP_BASE + "?key=" + encodeURIComponent(env.TMAP_KEY) + (qs ? "&" + qs : "");

  const upstream = await fetch(url, { method: "GET" });
  const text = await upstream.text();
  return passthrough(upstream.status, text);
}

/* ---------------- 入口（EdgeOne Pages Function Handler） ----------------
   onRequest 会匹配所有 HTTP 方法；签名与 Vercel 版完全不同：
   不再有 (req, res)，改为接收 context 并返回 Response。 */
export async function onRequest(context) {
  const request = context.request;
  const env = context.env || {};

  /* 预检请求直接放行（浏览器跨域时先发 OPTIONS） */
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return json(405, { error: { message: "仅支持 POST（CORS 预检可用 OPTIONS）" } });
  }

  /* Edge Function 无「已解析的 req.body」，必须手动读取文本再解析 */
  let payload = null;
  try {
    const rawText = await request.text();
    payload = rawText ? JSON.parse(rawText) : null;
  } catch (e) {
    payload = null;
  }
  if (!payload || typeof payload !== "object") {
    return json(400, { error: { message: "请求体必须是 JSON 对象" } });
  }

  const type = typeOf(payload);
  const gate = validate(type, env);
  if (!gate.ok) return json(gate.status, gate.obj);

  try {
    if (type === "qwen-text")  return await forwardDeepSeek(payload, env);
    if (type === "qwen-image") return await forwardVision(payload, env);
    if (type === "tmap-search") return await forwardTmap(payload, env);
    return await forwardAmap(payload, env);
  } catch (e) {
    return json(502, { error: { message: "上游请求失败：" + (e && e.message ? e.message : String(e)) } });
  }
}
