# 【交接说明】新会话从这里开始（2026-09-21 16:0x 由监督人写下）

> 你（Codex）在一个**长跑任务**里，上一个会话因为**上下文撑满、每轮都压缩失败**被换掉了。
> **你的所有历史都写在 `docs/` 里，一个字都不会丢。先把下面四份读完再动手。**

## 〇、先读这四份（按顺序，别跳过）
1. `docs/进度.md` —— **最上面那一节是最新的**（每轮的"做了什么/怎么验的/结果"都在）
2. `docs/自审清单.md` —— 每一轮自己抓出来的问题与修法
3. `docs/待办清单.md` —— 剩余总清单（按板块）
4. `docs/设计规范.md` —— 圆角/间距/字号/视觉权重/空间规范（全站必须遵守）
5. 踩过的坑：`docs/03-踩过的坑-上.md`、`docs/04-踩过的坑-下.md`（**必读，别重踩**）

## 一、这是什么工程（前端 / 后端说清楚）

**工作目录**：`/home/ubuntu/novel-app`
**一句话目标**：把「小说软件」从"套着别人后端的网页壳"，做成**属于我们自己的完整 App**
（自研后端 + 内嵌前端 + 安卓壳）。用户要在手机上当番茄小说那种 App 用。

### 前端 `frontend/`（纯静态，浏览器直接打开；App 内嵌同一份）
```
frontend/
  index.html          单页应用（所有屏都在这一个文件里，靠 id 切换）
  js/
    app.js            壳：屏路由 / 弹层(sheet) / 底部导航 / 图标 / 设置页的外观段
    api.js            接口层：**所有请求都要走 API.media()/API.nb()/API.abs()**
                      （前端挂在 /novel/ 子路径下，自己手拼 /api/... 会 404 —— 踩过）
    reader.js         书架 + 阅读器 + 阅读器底部面板(rd-quick) + 书本菜单
    chat.js           AI 对话页（干活方式：讨论/计划/执行；模型与渠道；联网搜索那一节）
    studio.js         剧情/世界面板（承载树/剧情线/伏笔/决策/场景）
    preset.js         预设页          lore.js  设定页
    tools.js          工具宫格 + 各工具面板      authoring.js  5 个新功能
    outline.js        「大纲」（**故事线工具点开就是它**，一份实现两个入口）
    appearance.js     「自定义背景图」（上传/换/移除/模式）
    ui.js             UI 工具箱（h() 建元素、三态渲染 loadingIn/emptyIn/failedIn）
    websearch.js      联网搜索那一节（对话设置里）
    bookctx.js        当前书 / 切书
  css/
    tokens.css        设计令牌（颜色/圆角/间距 --sp-* /字号阶梯）—— **改样式先看它**
    base.css components.css panels.css reader.css tools.css preset.css shelf.css
    decor.css         背景质感（波纹/竹影/纸纹 + 用户自定义背景层）
```

### 后端 `server/`（自研 FastAPI，跑在 127.0.0.1:8899，Caddy 反代到 `/novel/`）
```
server/
  app.py              入口：挂所有 router、挂静态前端(StaticFiles -> frontend/)、鉴权
  routers/            每个域一个文件（新增能力就在这里加）
                      books lore presets files tts agent config_models rag world plot
                      write lint stats export misc backup prompts notes model_sets sync
                      workflows voice pacing refs peer authoring appearance
  engine/             引擎层：websearch.py(联网搜索) agent_runtime.py orchestra.py(多Agent编排) …
  db.py store.py security.py paths.py
  数据：data/app.db(SQLite) · 用户小说 data/books/<slug>/manuscript/*.md
```
**规矩：后端只增不减**（不许删接口/删字段/改返回结构/动 `data/`）。动后端要跑全量回归。

### 安卓壳 `apk/`
WebView 壳；`tools/sync_pkg.py` 把 `frontend/` 同步进 `apk/assets/www`；`apk/build.sh` 打包。
**签名必须跟已装版本一致：`428cb931…8aa0`**（否则不能覆盖安装）。

### 其它
- `tools/` 判据与脚本：`e2e-*.js` 走 **CDP 真浏览器**（用 `cdp.js` 的 `clickSel()` = **真实鼠标事件**，
  不许再用 `el.click()`）；`check_*.py` 静态检查；`goal_driver.py` 是监督人的驱动器（**别改**）
- `docs/` 文档 + 每轮的实测 JSON + 截图（证据都在这）
- git 仓库：`https://github.com/gelijunge22-code/novel-app`（已推到 `01fe18b`）

## 二、上次断在哪
- **最后提交 `01fe18b`**（监督人交接提交，工作区干净、已 push）
- **第 43 轮「全站自定义背景图」**：代码写完、主判据 `tools/e2e-userbg.js` **20/20 绿**，
  反证 `tools/userbg_force_stale.sh` 红 2 条；**唯一卡点是自己写的一条判据误报**（别研究了，降级/绕过）

## 三、现在只做这两件 → 然后直接出包（用户已拍板）

### ① 自定义背景「传了看不见」（用户原话："切换整个前端的背景图是无用的"）
**监督人实测根因**：背景图**确实传上去了**（接口 200、7 个屏的 CSS 都引用了、有 `theme-paper ubg-cover` 图层），
**但截图逐像素看：一点蓝、一点黄都看不到** —— 被**不透明的纸色层 + 内置竹影/纸纹**盖死了。
- **修**：`has:true` 时 → `theme-paper` 变透明（或极低不透明度）、**内置质感退让**、
  图上加遮罩保证正文 ≥4.5:1 / 次要 ≥3:1、夜间自动压暗；`has:false` 时恢复现在的样子
- **判据（能报红）**：传一张**纯蓝图** → 逐像素检查"非蓝像素占比"必须低于阈值（现在是 100% 非蓝）
- **收尾**：`DELETE /api/appearance/bg`，`data/appearance/` 里文件数必须是 0

### ② AI 对话「下拉展开」里模型那几行的字凸出去（用户："字儿已经凸出去了，已经看不清了"）
- 展开态那个抽屉里（**模型选择 / 渠道 / 切换项**那几行）：长模型名/渠道名**用省略号或换行**
- **会话标题**超长也要省略号（监督人量的：超 17px `h1#chat-title`）
- **底部那排图标按钮**不许只露「ge…」「出…」（用户原话："底下就只能露出来 ge 了，全都看不清"）
- **判据**：跑 `node tools/e2e-textfit.js`，出框 = 0

### ③ 然后立刻收尾（不许再开新战线）
1. **`git commit` 一次**（做完①②就提交）
2. **重写 `DONE.md`**（写清：装哪个包、怎么装、有什么功能）
3. **打最终 APK**：版本号递增、**签名 `428cb931…8aa0`**、打完 `cd apk && gradle --stop`
4. **`docs/待办清单.md` 结账**（做完打勾，没做的写明"为什么不做了"）

## 四、规矩（照做）
- **只增不减**：不许删功能、不许删接口、不注水（复制改名/空壳/死代码/两套并存都不算）
- **绝不删用户的小说数据**；迁移只能复制
- **每 45 分钟必须提交一次**（哪怕只有两行）—— 用户会因为"2 小时没提交"以为你死了
- **卡在自己写的判据/脚本上超过 20 分钟 → 直接跳过、记 TODO、往下走**（上一轮就是这么耗掉 3 小时的）
- **跳过 `frontend/` 体积翻倍这个指标**（已作废，别为凑数字加东西）
- **测试必须走真浏览器**（CDP `clickSel()` 真实鼠标事件），别用 `el.click()`
- **服务器只有 3.6G 内存**：不许并行跑测试/打包；`apk/gradle.properties` 的 `-Xmx768m` 不许调大；
  测试完 `node tools/sweep_chrome.js` 收无头浏览器
- 每轮在 `docs/进度.md` 留证据（做了什么/怎么验的/结果）

## 五、现在就开始
先读上面五份文档 → 然后在 `docs/进度.md` 顶部补一句"新会话接手，接着做 ①②③" →
然后直接干 ① 和 ②。**不要重头再来。**
