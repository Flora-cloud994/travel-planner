/* ============================================================================
   travel-planner 内置发布通道服务端（单端口）
   ----------------------------------------------------------------------------
   为什么需要这个文件：
     WorkBuddy 内置发布通道只暴露**单个公共端口**，且只托管静态资源 ——
     它不认识 EdgeOne 的 edge-functions/ 目录，所以直接部署 public/ 时
     /api/proxy 会是 404，识别与地图功能全部不可用。

   本文件做两件事（同一个 HTTP 服务）：
     ① 静态托管 public/ 下的前端资源
     ② 把 /api/proxy 的请求转交给 edge-functions/api/proxy.js 的 onRequest
        （复用同一份代理逻辑，零重复实现 —— 避免两套代码漂移）

   环境变量注入：
     proxy.js 读的是 context.env.X，这里用 process.env 构造 context，
     所以环境变量名与 EdgeOne / Vercel 完全一致，配一次到处通用：
       DEEPSEEK_KEY / ZHIPU_KEY / DASHSCOPE_KEY / AMAP_KEY / TMAP_KEY
   ============================================================================ */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const PROXY_FILE = path.join(ROOT, "edge-functions", "api", "proxy.js");

/* ----------------------------------------------------------------------------
   轻量 .env 载入（不引第三方依赖）
   ----------------------------------------------------------------------------
   内置发布通道**不会**注入环境变量（实测 /api/health 全为 false），所以
   Key 必须随代码一起带上去 —— 从项目根目录的 .env 读。

   优先级：真实进程环境变量 > .env 文件
   （这样本地 export AMAP_KEY=... 依然最高优先级，方便临时覆盖测试）

   安全说明：
     · .env 已在 .gitignore 中，不会被提交到 Git 仓库；
     · 但它会随部署包上传到托管沙箱 —— Key 始终只存在于服务端，
       浏览器端拿不到（前端零 Key 的设计不变）。
   ---------------------------------------------------------------------------- */
function loadDotEnv() {
  const envPath = path.join(ROOT, ".env");
  let raw;
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch (e) {
    console.log("[boot] 未找到 .env（跳过文件载入，改用进程环境变量）");
    return;
  }
  let loaded = 0;
  raw.split(/\r?\n/).forEach((line) => {
    const s = line.trim();
    if (!s || s.startsWith("#")) return;
    const i = s.indexOf("=");
    if (i < 0) return;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    /* 去掉可能存在的成对引号 */
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!k || !v) return;             /* 空值不覆盖 */
    if (process.env[k]) return;       /* 真实环境变量优先 */
    process.env[k] = v;
    loaded++;
  });
  console.log("[boot] 已从 .env 载入 " + loaded + " 个变量");
}

loadDotEnv();

const PORT = Number(process.env.PORT) || 3000;

/* 资源类型映射（内置通道没有自动 MIME，必须自己给） */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8"
};

/* ---------- 载入代理模块（只做一次，常驻内存） ---------- */
let proxyModule = null;
let proxyLoadError = null;

async function loadProxy() {
  if (proxyModule || proxyLoadError) return;
  try {
    const mod = await import(pathToFileURL(PROXY_FILE).href);
    if (typeof mod.onRequest !== "function") {
      throw new Error("proxy.js 未导出 onRequest 函数");
    }
    proxyModule = mod;
    /* 启动期自检：让「Key 配没配」一目了然，方便排查 */
    const names = ["DEEPSEEK_KEY", "ZHIPU_KEY", "DASHSCOPE_KEY", "AMAP_KEY", "TMAP_KEY"];
    const present = names.filter((n) => !!process.env[n]);
    const missing = names.filter((n) => !process.env[n]);
    console.log("[boot] 代理模块已加载：" + PROXY_FILE);
    console.log("[boot] 已配置的环境变量：" + (present.length ? present.join(", ") : "（无）"));
    if (missing.length) console.log("[boot] 未配置（相关功能将不可用）：" + missing.join(", "));
  } catch (e) {
    proxyLoadError = e;
    console.error("[boot] 代理模块加载失败：" + (e && e.message ? e.message : String(e)));
  }
}

/* ---------- 把 Node 的 IncomingMessage 读成完整请求体 ---------- */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/* ---------- 静态文件服务 ---------- */
function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch (e) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("400 Bad Request");
    return;
  }

  if (urlPath === "/") urlPath = "/index.html";

  /* 路径穿越防护：解析后必须仍在 PUBLIC_DIR 内 */
  const target = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("403 Forbidden");
    return;
  }

  fs.stat(target, (err, st) => {
    if (!err && st.isFile()) {
      const ext = path.extname(target).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Content-Length": st.size,
        "Cache-Control": "public, max-age=300"
      });
      fs.createReadStream(target).pipe(res);
      return;
    }
    /* 目录或不存在 → 回退到首页（本应用是单页，任何深链都给 index.html） */
    const indexPath = path.join(PUBLIC_DIR, "index.html");
    fs.stat(indexPath, (e2, st2) => {
      if (e2 || !st2.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("404 Not Found —— 请先运行 `node sync-index.cjs` 生成 public/");
        return;
      }
      res.writeHead(200, {
        "Content-Type": MIME[".html"],
        "Content-Length": st2.size,
        "Cache-Control": "no-cache"
      });
      fs.createReadStream(indexPath).pipe(res);
    });
  });
}

/* ---------- 代理请求：把 Node 请求转成 Web 标准 Request ---------- */
async function handleProxy(req, res) {
  await loadProxy();

  if (!proxyModule) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      error: { message: "代理模块加载失败：" + (proxyLoadError && proxyLoadError.message ? proxyLoadError.message : "未知原因") }
    }));
    return;
  }

  try {
    const bodyBuf = await readBody(req);
    const headers = {};
    Object.keys(req.headers).forEach((k) => { headers[k] = req.headers[k]; });

    const webRequest = new Request("http://localhost" + req.url, {
      method: req.method,
      headers: headers,
      body: (req.method === "GET" || req.method === "HEAD") ? undefined : bodyBuf
    });

    /* ⚠️ 关键一桥：proxy.js 读 context.env，这里把 process.env 灌进去。
       借此让「内置通道」与「EdgeOne」共用同一份代理逻辑与同一套变量名。 */
    const response = await proxyModule.onRequest({
      request: webRequest,
      env: process.env,
      params: {},
      waitUntil: function () {}
    });

    const outHeaders = {};
    response.headers.forEach((v, k) => { outHeaders[k] = v; });
    const outBody = Buffer.from(await response.arrayBuffer());
    outHeaders["Content-Length"] = outBody.length;

    res.writeHead(response.status, outHeaders);
    res.end(outBody);
  } catch (e) {
    console.error("[proxy] 转发异常：" + (e && e.stack ? e.stack : String(e)));
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      error: { message: "服务端转发失败：" + (e && e.message ? e.message : String(e)) }
    }));
  }
}

/* ---------- 服务器 ---------- */
const server = http.createServer(async (req, res) => {
  const urlPath = (() => {
    try { return new URL(req.url, "http://localhost").pathname; } catch (e) { return req.url; }
  })();

  if (urlPath === "/api/proxy" || urlPath === "/api/proxy/") {
    handleProxy(req, res);
    return;
  }

  /* 健康检查：部署后立刻能确认服务与 Key 状态 */
  if (urlPath === "/api/health") {
    /* 先确保代理模块已加载，避免在首个请求到达前误报 false */
    await loadProxy();
    const names = ["DEEPSEEK_KEY", "ZHIPU_KEY", "DASHSCOPE_KEY", "AMAP_KEY", "TMAP_KEY"];
    const configured = {};
    names.forEach((n) => { configured[n] = !!process.env[n]; });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      ok: true,
      proxyModuleLoaded: !!proxyModule,
      env: configured,
      port: PORT
    }, null, 2));
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("405 Method Not Allowed");
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("[boot] travel-planner 服务已启动：http://0.0.0.0:" + PORT);
  console.log("[boot] 静态目录：" + PUBLIC_DIR);
});
