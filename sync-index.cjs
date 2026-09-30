/* ============================================================================
   sync-index.cjs —— 把 travel-planner.html 同步为 index.html
   ----------------------------------------------------------------------------
   为什么要两份：Vercel 静态站点在根路径 / 默认找 index.html，而本项目的
   主文件叫 travel-planner.html。为了让分享链接是 https://xx.vercel.app
   （不带文件名），需要一份同名副本。

   它俩必须内容一致，否则「改了一份忘了另一份」会导致线上与本地不一致。
   故：**只改 travel-planner.html，然后跑 npm run sync 生成 index.html**。
   （Vercel 的 Build Command 已配置为 `node sync-index.cjs`，部署时自动执行。）

   用法：
     node sync-index.cjs         生成 / 覆盖 index.html
     node sync-index.cjs --check 只校验是否一致，不一致则退出码 1（给 CI 用）

   ⚠️ 为什么扩展名是 .cjs 而不是 .js：
     本脚本用 `require` / `__dirname`（CommonJS 写法）。若 package.json 里
     声明了 "type":"module"，Node 会把 .js 当 ESM 解析 → 直接报
     "require is not defined in ES module scope"，导致 Vercel 构建失败。
     用 .cjs 扩展名可**强制**按 CommonJS 解析，与 package.json 无关，最稳。
   ============================================================================ */
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "travel-planner.html");
const DST = path.join(__dirname, "index.html");
const checkOnly = process.argv.includes("--check");

if (!fs.existsSync(SRC)) {
  console.error("[sync-index] 找不到源文件 travel-planner.html");
  process.exit(1);
}

const src = fs.readFileSync(SRC, "utf8");
const same = fs.existsSync(DST) && fs.readFileSync(DST, "utf8") === src;

if (checkOnly) {
  if (same) {
    console.log("[sync-index] ✅ index.html 与 travel-planner.html 一致");
    process.exit(0);
  }
  console.error("[sync-index] ❌ index.html 与 travel-planner.html 不一致，请运行：node sync-index.js");
  process.exit(1);
}

if (same) {
  console.log("[sync-index] 已是同步状态，无需改动");
  process.exit(0);
}

fs.writeFileSync(DST, src);
console.log("[sync-index] 已生成 index.html（" + Buffer.byteLength(src) + " 字节）");
