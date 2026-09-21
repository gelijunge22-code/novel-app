# 写作台 · NovelApp

一个**自己的小说写作 App**：自研后端 + 移动端网页 + 安卓壳。
下载下来就是你的，稿子只存在你自己的机器上，不经过任何第三方。

> 一句话：**clone 下来 → 装依赖 → 跑起来 → 自己的写作台**。
> 仓库里不带任何别人的稿子、设定或密钥。

---

## 一分钟跑起来

```bash
git clone <这个仓库>
cd novel-app

python3 -m venv server/venv
server/venv/bin/pip install -r requirements.txt      # 就 5 个包

# 第一次启动会自己建库、自己生成口令
server/venv/bin/python -m uvicorn server.app:app --host 127.0.0.1 --port 8899
```

浏览器打开 **http://127.0.0.1:8899/** 就是网页版。

**第一次的口令在哪？** 按这个顺序取：

1. 你启动前设的环境变量 `NOVELAPP_INIT_PASSWORD`
2. 没设就自动生成一个，写在 `data/initial-password.txt`（权限 600）

```bash
cat data/initial-password.txt
```

## 想给外网访问？（可选）

前端和接口在同一个端口上，前面挂个反向代理就行。
仓库里带了现成的 systemd 服务：`deploy/novelapp.service`。

```bash
cp deploy/novelapp.service ~/.config/systemd/user/
systemctl --user enable --now novelapp
```

> **公网一定要自己加一层认证**（Caddy / Nginx 的 basic auth 都行），
> 别把没口令的端口直接暴露出去。

## 你的东西存在哪

```
data/books/<书名>/          正文、设定、角色卡、大纲
data/app.db                 会话、世界引擎的实体与事实
data/initial-password.txt   第一次启动生成的口令
```

- **全都在你本机**，仓库里 `.gitignore` 已经把 `data/` 排除 → **不会误传**
- 删书先进 `data/trash/`，不直接抹
- 备份 = 把 `data/` 整个复制走

## 安卓 App（可选）

```bash
bash apk/build.sh              # 需要 JDK + Android SDK
bash tools/verify_apk.sh       # 打完自查：版本号 / 签名 / 内嵌前端 / 后端齐全
```

> 本地打包需要 keystore（`apk/keystore.jks`，不进 git）。
> 没有的话自己生成一个，或者只用网页版。

## 怎么跑测试

```bash
server/venv/bin/python tools/verify_api.py       # 接口全量
server/venv/bin/python tools/verify_routers.py   # 路由
node tools/e2e.js                                # 前端全站走查
```

## 目录

```
server/     后端（Python / FastAPI）
  ├ routers/    接口层
  ├ engine/     世界引擎、质检、编排、记忆、节奏…
  └ assets/     内置文风 / 范文（随包走，可自己加）
frontend/   前端源码（HTML / CSS / JS）
apk/        安卓壳 + 打包脚本
docs/       设计文档、进度、踩坑记录、实测报告
tools/      自测与校验脚本
data/       运行数据（不进 git）
```

## 主要功能

- **写作台**：正文、细纲、续写、改写、润色，章节树
- **世界引擎**：实体 / 别名 / 事实 / 关系 / 时间线，**能从设定文件里一键认事实**
- **伏笔账本**：埋了什么、还没回收什么
- **AI 味质检**：比喻堆砌、排比抒怀、段尾总结、空泛形容词逐条标出来
- **多 Agent 编排**：主创 → 取上下文 → 查证 → 挑刺 的流水线
- **预设**：8 个档案（写作 / 主创 / 素材 / 世界 / 查证 / 挑刺 / 取上下文 / 内联改稿），**出厂就带可用的默认提示词**
- **听书**（edge-tts）、**导出**（TXT / Markdown / EPUB）、**备份**

## 常见问题

**端口被占？** 换一个：`--port 8900`，或者改 `server/config.json`。

**忘了口令？** 停掉服务，删掉 `data/app.db` 里的 `user` 表记录，重启会重新生成
（**这会丢掉登录，不会动你的书稿**）。

**想换前端样式？** 改 `frontend/css/tokens.css` 里的令牌，全站跟着变。

## 许可证

本项目为**原创实现**：代码全部自己写。

**本仓库采用 [AGPL-3.0](LICENSE)** —— 见 `LICENSE` 文件。

意思很简单：

- ✅ 你可以随便用、随便改、自己私下用多少年都行
- ✅ 改完可以自己留着，不用告诉任何人
- ⚠️ 但只要你**把改过的版本放到网上给别人用**（做成网站、App、或者转发），
  就**必须把你改的那份源码也公开出来**，并且同样用 AGPL-3.0
- ❌ 不能拿去做一个**闭源**的网站或 App 去卖钱

如果你是作者本人（自己用、自己改），以上限制**都跟你没关系**。
