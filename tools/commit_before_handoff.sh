#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 提交前：确认稿子和密钥不会被提交 ═══"
echo "  会被提交的 data/ 文件数（应该是 0）: $(git status --short --porcelain | grep -c '^.. data/')"
echo "  会被提交的 .env 数（应该是 0）: $(git status --short --porcelain | grep -cE '\.env$')"
echo "  会被提交的 server/config.json 数（应该是 0）: $(git status --short --porcelain | grep -c 'server/config.json')"
echo
echo "═══ 提交 ═══"
git add -A
git commit -q -F - <<'EOF'
监督人交接提交（切换上下文前落地）

- 第43轮 全站自定义背景图：frontend/js/appearance.js（新）+ server/routers/appearance.py（新）
  + frontend/css/decor.css / tokens.css / components.css / index.html / app.js 配套改动
- 服务端注册 appearance 路由（server/app.py）
- 监督人修的驱动器 bug：goal_driver.py —— 原来目标一变 blocked 就退出，
  systemd(Restart=always) 每 2.5 分钟重启一次（restart counter 到 150），
  正在跑的活被反复腰斩。现在改成"blocked 原地重新激活，不退出"。
- docs/进度.md + 自审清单 + 各实测 JSON/截图（第 43 轮那批）
- tools/：监督人本轮探针（bg_real2 / chat_bg_probe / two_probe / check_repo_full 等）
EOF
echo "  提交结果: $(git log -1 --pretty=format:'%h %s' | cut -c1-100)"
echo
echo "═══ 推送 ═══"
timeout 120 git push 2>&1 | tail -4 | sed 's/^/  /'
echo
echo "═══ 核对 ═══"
echo "  本地 HEAD: $(git log -1 --pretty=format:'%h')"
echo "  远程 main: $(git log -1 origin/main --pretty=format:'%h' 2>/dev/null || echo '(取不到)')"
echo "  还没提交的: $(git status --short | wc -l) 个"
echo "  关键新文件进仓库了吗:"
for f in frontend/js/appearance.js server/routers/appearance.py; do
  git ls-files --error-unmatch "$f" >/dev/null 2>&1 && echo "    ✅ $f" || echo "    ❌ $f"
done
