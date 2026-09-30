/* ============================================================================
   sync-index.cjs —— 把 travel-planner.html 同步为 index.html，并生成 public/
   ----------------------------------------------------------------------------
   为什么要有 index.html：
     Vercel 静态站点在根路径 / 默认找 index.html，而本项目主文件叫
     travel-planner.html。为了让分享链接是 https://xx.vercel.app（不带文件名），
     需要一份同名副本。两者必须内容一致，否则「改了一份忘了另一份」会导致
     线上与本地不一致。故：**只改 travel-planner.html，然后跑 npm run sync**。

   为什么还要生成 public/：
     Vercel 的 Framework Preset 若为「Other」，其默认 Output Directory 是
     `public`（若存在）否则 `.`。若控制台里 Output Directory 覆盖项被误填成
     `public`，构建完成后就会报：
         Error: No Output Directory named "public" found after the Build completed.
     本脚本顺带生成 public/（含 index.html 与 data/ 全量副本），使**两种判定
     路径都能找到产物**，从根上消除该失败。vercel.json 已声明
     "outputDirectory": "."，正常情况下会直接用根目录；public/ 只是冗余保险。

   用法：
     node sync-index.cjs         生成 index.html + public/
     node sync-index.cjs --check 只校验一致性，不一致则退出码 1（给 CI 用）

   ⚠️ 为什么扩展名是 .cjs 而不是 .js：
     本脚本用 `require` / `__dirname`（CommonJS 写法）。若 package.json 里
     声明了 "type":"module"，Node 会把 .js 当 ESM 解析 → 直接报
     "require is not defined in ES module scope"，导致 Vercel 构建失败。
     用 .cjs 可**强制**按 CommonJS 解析，与 package.json 无关，最稳。
   ============================================================================ */
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const SRC = path.join(ROOT, "travel-planner.html");
const DST = path.join(ROOT, "index.html");
const DATA_DIR = path.join(ROOT, "data");
const PUBLIC_DIR = path.join(ROOT, "public");
const checkOnly = process.argv.includes("--check");

if (!fs.existsSync(SRC)) {
  console.error("[sync-index] ❌ 找不到源文件 travel-planner.html");
  process.exit(1);
}

const src = fs.readFileSync(SRC, "utf8");
const same = fs.existsSync(DST) && fs.readFileSync(DST, "utf8") === src;

if (checkOnly) {
  if (same) {
    console.log("[sync-index] ✅ index.html 与 travel-planner.html 一致");
    process.exit(0);
  }
  console.error("[sync-index] ❌ index.html 与 travel-planner.html 不一致，请运行：node sync-index.cjs");
  process.exit(1);
}

/* ---------- ① 同步 index.html ---------- */
if (same) {
  console.log("[sync-index] index.html 已是同步状态");
} else {
  fs.writeFileSync(DST, src);
  console.log("[sync-index] ✅ 已生成 index.html（" + Buffer.byteLength(src) + " 字节）");
}

/* ---------- ② 生成 public/（冗余保险，兼容 Other 预设默认输出目录） ---------- */
function copyDir(from, to) {
  if (!fs.existsSync(from)) return 0;
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const name of fs.readdirSync(from)) {
    const f = path.join(from, name);
    const t = path.join(to, name);
    if (fs.statSync(f).isDirectory()) n += copyDir(f, t);
    else { fs.copyFileSync(f, t); n++; }
  }
  return n;
}

try {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  fs.writeFileSync(path.join(PUBLIC_DIR, "index.html"), src);
  fs.writeFileSync(path.join(PUBLIC_DIR, "travel-planner.html"), src);
  const copied = copyDir(DATA_DIR, path.join(PUBLIC_DIR, "data"));
  console.log("[sync-index] ✅ 已生成 public/（index.html + data/ 共 " + copied + " 个文件）");
} catch (e) {
  /* public/ 只是保险，失败不影响主路径（根目录部署仍可用），故仅告警不中断 */
  console.warn("[sync-index] ⚠️ 生成 public/ 失败（不影响根目录部署）：" + e.message);
}
