# EdgeOne Makers 部署指南（travel-planner v16.0）

> 本文件记录从 Vercel 迁移到腾讯云 EdgeOne Makers 的**用户侧操作步骤**。
> 代码侧改造已全部完成并推送（commit `6c2e779`），这里只讲怎么上线。

---

## 为什么换平台

Vercel 的节点在境外，境内访问不稳定 —— 这正是之前「只有用外网才能进」的
体感来源（叠加上当时 Vercel 的 Deployment Protection 挡着）。

EdgeOne Makers 是腾讯云的产品，**走国内边缘节点**，境内访问直连、
不用梯子。免费额度：每月 300 万 Edge Functions 请求、500 次构建、
流量不限。

---

## 一、准备工作

1. 打开 https://console.tencentcloud.com/edgeone/pages
   （用腾讯云账号登录；没有就注册，支持微信/QQ 快捷登录）
2. 首次进入需要**开通 Makers 服务**（免费，点授权即可）
3. 确保 GitHub 仓库 `Flora-cloud994/travel-planner` 已推送最新代码
   （已完成，commit `6c2e779`）

---

## 二、创建项目

在 Makers 控制台点 **「创建项目」** → 选择 **「导入 Git 仓库」** →
授权并选中 `Flora-cloud994/travel-planner`。

### 构建配置（照抄填）

| 配置项 | 值 |
|---|---|
| 框架预设 | 选「其他 / Other」（本项目是原生静态站，不是框架） |
| 构建命令 Build Command | `node sync-index.cjs` |
| 输出目录 Output Directory | `.` |
| 根目录 Root Directory | 留空（仓库根） |
| Node 版本 | `20.18.0`（edgeone.json 已指定） |

> **为什么构建命令是 `node sync-index.cjs`？**
> 项目源文件是 `travel-planner.html`，构建脚本把它复制成 `index.html`
> 交给静态托管。不跑这一步部署出来是 404。

> 以上三项也写在仓库的 `edgeone.json` 里了，会**自动覆盖控制台配置** ——
> 所以即使控制台没填对，也会以 `edgeone.json` 为准。但仍建议填对以便排查。

---

## 三、配置环境变量（关键步骤）

项目创建后 → **设置 → 环境变量**，逐条添加：

| 变量名 | 必需 | 用途 | 获取地址 |
|---|---|---|---|
| `AMAP_KEY` | **必需** | 地点定位、路线规划、接驳方案 | 高德开放平台 → 应用管理 → 添加 Key → **服务平台必须选「Web服务」** |
| `DEEPSEEK_KEY` | **必需** | 攻略文本识别（粘贴文案 → 抽地点） | https://platform.deepseek.com/api_keys |
| `ZHIPU_KEY` | 可选 | 截图识别（**推荐配上**） | https://open.bigmodel.cn/ → API 密钥管理 |
| `DASHSCOPE_KEY` | 可选 | 截图识别备选（`ZHIPU_KEY` 未配时才用） | https://bailian.console.aliyun.com/ → API-KEY |
| `TMAP_KEY` | 可选 | 到达点搜索（车站/机场） | 腾讯位置服务 → 应用管理 → 添加 Key → 勾选「WebService API」 |

### 两个提醒

1. **变量名与 Vercel 时期完全一致**，不用改。代码侧只是把读取方式从
   `process.env.KEY` 改成了 `context.env.KEY`（Edge Function 运行时的约束）。
2. **改完环境变量要重新触发一次部署**才会生效 —— 环境变量在构建/部署时注入。

### 不配的后果（不会白屏，功能按需降级）

- 缺 `AMAP_KEY` → 地点定位/路线/接驳全部不可用（这是必需项）
- 缺 `DEEPSEEK_KEY` → 「粘贴攻略文本」识别不可用
- 缺 `ZHIPU_KEY` 和 `DASHSCOPE_KEY` → 「上传截图」识别不可用
- 缺 `TMAP_KEY` → 到达点搜索退化，但接驳费用/时间仍按坐标距离估算显示

---

## 四、部署

点 **「开始部署」**。约 1–3 分钟完成。首次部署成功后你会拿到一个
`xxx.edgeone.app` 的访问域名。

**验证清单**（务必逐条过）：

1. 打开首页 —— 应看到行程规划界面，**不跳登录页**
2. 无痕窗口再开一次 —— 结果应完全一致（排除「只是我有 cookie」）
3. 手机用 4G/5G 流量打开（不连 WiFi）—— 能开说明国内访问打通了
4. 界面上随便粘贴一段攻略文字试识别 —— 能出地点说明 `DEEPSEEK_KEY` 生效
5. 地图上能点选地点、能算路线 —— 说明 `AMAP_KEY` 生效

---

## 五、换自己的域名（可选）

设置 → 域名管理 → 添加自定义域名，拿到 CNAME 值后：
1. 去 DNS 服务商控制台，**删掉原来指向 Vercel 的 A/AAAA/CNAME 记录**
2. 加一条 CNAME，指向 EdgeOne 给的新值
3. 等 DNS 生效（几分钟到几小时）

EdgeOne 还支持**免费证书申请**和**托管 SSL**，HTTPS 不用另外买。

---

## 六、故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 首页 404 | 构建命令没跑（缺 `index.html`） | 确认 Build Command = `node sync-index.cjs` |
| 页面正常但识别/地图全挂 | 环境变量没配或没重新部署 | 补配后**重新部署一次** |
| `/api/proxy` 报 404 | 函数目录不对 | 应为 `edge-functions/api/proxy.js`（不是 `functions/api/`） |
| `/api/proxy` 报 500 | 缺必需 Key | 检查 `AMAP_KEY` / `DEEPSEEK_KEY` |
| 构建报 Node 版本错误 | `nodeVersion` 写了非预装版本 | 只能用 `14.21.3 / 16.20.2 / 18.20.4 / 20.18.0 / 22.11.0` |

### 关于函数目录（最容易踩的坑）

EdgeOne Makers 有**两套**函数目录，别搞混：

| 类型 | 目录 | 运行时 |
|---|---|---|
| **Edge Functions**（本项目用这个） | `edge-functions/api/` | Edge Runtime（Web 标准 API） |
| Cloud Functions | `cloud-functions/api/` | Node.js 20 / Python 3.10 / Go |

本项目是代理转发，逻辑轻、延迟敏感，选 Edge Function。
路由由目录结构自动生成：`edge-functions/api/proxy.js` → `/api/proxy`。

---

## 七、本地开发（可选）

```bash
# 安装 CLI（需 Node ≥ 18）
npm install -g edgeone

# 本地起服务（会同时跑静态资源和 Edge Functions）
edgeone makers dev

# 配本地环境变量后即可完整调试
```

> 注意：CLI 命名空间已从 `edgeone pages` 迁移到 `edgeone makers`
> （旧命名空间过渡期仍可用，执行时会打弃用提示）。
