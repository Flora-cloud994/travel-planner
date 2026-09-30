# 智能旅行规划器（travel-planner）

粘贴小红书 / 抖音 / 游记攻略文本，或上传、`Ctrl+V` 直接粘贴截图 —— 自动识别其中的景点、住宿、美食，落到**真实坐标**上，生成带路线、预算与接驳信息的行程方案。

> **v13.0 起，所有第三方 API Key 都放在服务端**。前端代码里不含任何 Key，可安全地分享给他人使用。

---

## 一、它能做什么

| 模块 | 说明 |
| --- | --- |
| 智能导入 | 千问文本 / 视觉模型抽取地点 → 高德 POI 搜索定位真实坐标 → 分天聚类连线 |
| 地图交互 | 腾讯地图底图，地点标记、路线、拖拽排序 |
| 预算联动 | 总预算 + 每晚房费上限，超预算自动标灰、自动替换同城更便宜住宿 |
| 接驳联动 | 到达点（车站 / 机场）→ 首晚酒店的公交 / 打车方案，费用计入预算 |
| 方案管理 | 保存 / 载入 / 清空方案，自动回填去重 |

---

## 二、架构

```
浏览器（travel-planner.html，零 Key）
        │  POST /api/proxy   { type, ... }
        ▼
Vercel Serverless（api/proxy.mjs，持有 Key）
        │
        ├── type=qwen-text   → DashScope  /compatible-mode/v1/chat/completions
        ├── type=qwen-image  → DashScope  /compatible-mode/v1/chat/completions
        ├── type=amap-search → 高德        /v3/place/text 等
        └── type=tmap-search → 腾讯地图    /ws/place/v1/search
```

**四种 `type` 的请求格式：**

```js
// 千问文本 / 视觉（body 为 OpenAI 兼容请求体）
{ type: "qwen-text",  body: { model: "qwen-plus",    messages: [...] } }
{ type: "qwen-image", body: { model: "qwen-vl-plus", messages: [...] } }

// 高德 POI 搜索
{ type: "amap-search", path: "place/text", params: { keywords: "丽江古城", citylimit: "false" } }

// 腾讯地图 POI 搜索（params 为已编码的查询串）
{ type: "tmap-search", params: "keyword=丽江站&boundary=region(丽江市,0)&page_size=8" }
```

高德通道有**路径白名单**（`place/text`、`direction/transit/integrated`、`direction/driving`），腾讯通道有**参数名白名单**（`keyword`/`boundary`/`page_size`/`page_index`），代理不会被当成任意请求转发器使用。

---

## 三、部署到 Vercel（推荐，5 分钟）

### 1. 准备两个 Key

| 环境变量 | 用途 | 是否必填 | 申请地址 |
| --- | --- | --- | --- |
| `DASHSCOPE_KEY` | 千问识别（文本 + 视觉） | **必填** | 阿里云百炼控制台 → **API-KEY 管理** |
| `AMAP_KEY` | 高德地点搜索 / 路线规划 | **必填** | 高德开放平台 → 应用管理 → 添加 Key，**服务平台必须选「Web服务」** |
| `TMAP_KEY` | 腾讯地图「到达点搜索」 | 可选 | 腾讯位置服务 → 应用管理 → 添加 Key，勾选 **WebService API** |

> 高德 Key 若选成「Web端(JS API)」，服务端调用会报 `USERKEY_PLAT_NOMATCH`。
>
> **`TMAP_KEY` 可以不填**：不填时「到达点搜索」搜不到结果，接驳方案退化为按坐标距离估算（费用与时间仍正常显示），其余功能不受影响。

### 2. 推到 GitHub

```bash
cd travel-planner
git init
git add .
git commit -m "travel-planner v13.0"
git remote add origin <你的仓库地址>
git push -u origin main
```

`.env` 已在 `.gitignore` 中，不会误提交。

### 3. 在 Vercel 导入项目

1. 登录 [vercel.com](https://vercel.com) → **Add New… → Project** → 选择上面的仓库；
2. **Framework Preset** 选 `Other`（本项目的根目录 `travel-planner.html` 会作为静态页面自动部署，`api/proxy.mjs` 自动识别为 Serverless 函数）；
3. 展开 **Environment Variables**，添加：
   - `DASHSCOPE_KEY` = 你的千问 Key（必填）
   - `AMAP_KEY` = 你的高德 Web 服务 Key（必填）
   - `TMAP_KEY` = 你的腾讯位置服务 Key（**可选**，不填则「到达点搜索」不可用）
4. 点 **Deploy**，等待完成。

部署完成后拿到形如 `https://xxx.vercel.app` 的地址，直接分享给任何人即可使用。

### 4. （可选）自定义域名

Vercel 项目 → **Settings → Domains** 添加你的域名并按提示配置 DNS。

---

## 四、本地开发 / 自测

```bash
npm install          # 安装 vercel CLI
cp .env.example .env # 填入两个 Key（.env 不会被提交）
npm run dev          # 启动 vercel dev，默认 http://localhost:3000
```

浏览器打开 `http://localhost:3000/travel-planner.html` 即可。

> 直接用 `file://` 打开 HTML **不支持**代理（同源策略下 `/api/proxy` 无法解析），请务必通过 HTTP 服务访问。

---

## 五、目录结构

```
├── api/
│   └── proxy.mjs          # Serverless 代理：四种 type 转发，Key 从环境变量读取
├── data/
│   ├── data-coords.js    # 坐标修正表
│   ├── data-yn.js        # 云南城市 POI 数据
│   ├── data-gz.js        # 贵州城市 POI 数据
│   ├── data-sc.js        # 四川城市 POI 数据
│   └── data-hotels.js    # 住宿数据
├── travel-planner.html   # 单文件前端（含全部 UI / 逻辑 / 样式）——★ 主文件，改这里
├── index.html            # 由 travel-planner.html 自动同步生成（勿手改）
├── sync-index.cjs         # 同步脚本（部署时自动运行）
├── vercel.json           # Serverless 函数 + 构建命令配置
├── package.json
├── .env.example          # 环境变量清单（不含值）
└── .gitignore
```

> **为什么要两份 HTML**：Vercel 在根路径 `/` 默认找 `index.html`，而主文件叫 `travel-planner.html`。为了分享链接是不带文件名的 `https://xx.vercel.app`，需要一份同名副本。**只改 `travel-planner.html`**，然后跑 `npm run sync` 重新生成 `index.html`（部署时 Vercel 会通过 `buildCommand` 自动执行）。

---

## 六、安全说明

- 前端**不含任何 API Key**（千问 / 高德 / 腾讯三个 Key 全部在服务端），也不提供 Key 输入框；Key 只存在于 Vercel 环境变量与已 gitignore 的本地 `.env`。
- 建议在 DashScope、高德、腾讯位置服务控制台分别设置**每日调用上限 / 流量限制**，防止 Key 被滥用。
- 如需限制使用范围，可在 `api/proxy.mjs` 的 `setCors` 中把 `Access-Control-Allow-Origin` 由 `*` 改为你的域名。

---

## 七、常见问题

**Q：页面打开但识别一直失败？**
先确认环境变量已配置且**重新部署**（Vercel 修改环境变量后需 Redeploy 才生效）。

**Q：提示「服务端未配置 DASHSCOPE_KEY」？**
对应环境变量缺失或拼写错误，注意是 `DASHSCOPE_KEY`（不是 `DASHSCOPE_API_KEY`）。

**Q：高德报 `USERKEY_PLAT_NOMATCH`？**
Key 的服务平台类型不对，需重新申请「Web服务」类型的 Key。

**Q：`maxDuration` 想调更大？**
改 `vercel.json` 中 `api/proxy.mjs` 的 `maxDuration`（Hobby 计划上限 60 秒）。
