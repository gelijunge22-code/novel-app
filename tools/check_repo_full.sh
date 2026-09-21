#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 仓库里跟踪了哪些大目录 ═══"
for d in frontend server apk docs tools ref; do
  n=$(git ls-files "$d" 2>/dev/null | wc -l)
  echo "  $d/  已跟踪 $n 个文件"
done
echo
echo "═══ 2. 关键文件在不在仓库里 ═══"
for f in frontend/index.html frontend/js/app.js frontend/js/reader.js frontend/js/chat.js frontend/js/outline.js frontend/js/appearance.js frontend/css/tokens.css server/app.py server/routers/appearance.py server/routers/tts.py apk/build.sh apk/手机写作台.apk docs/进度.md docs/自审清单.md GOAL.md README.md; do
  if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then echo "  ✅ $f"; else echo "  ❌ 没进仓库: $f"; fi
done
echo
echo "═══ 3. 工作区没提交的东西（切换前必须落地）═══"
git status --short | head -40 | sed 's/^/  /'
echo "  共 $(git status --short | wc -l) 个"
echo
echo "═══ 4. 有没有东西被 .gitignore 挡住但很重要 ═══"
cat .gitignore 2>/dev/null | grep -vE '^#|^$' | head -20 | sed 's/^/  /'
echo
echo "═══ 5. 本地 vs 远程 ═══"
echo "  本地 HEAD: $(git log -1 --pretty=format:'%h %s' | cut -c1-70)"
echo "  远程 main: $(git log -1 origin/main --pretty=format:'%h %s' 2>/dev/null | cut -c1-70 || echo '(取不到)')"
echo "  差几个提交: $(git rev-list --count origin/main..HEAD 2>/dev/null || echo '?')"
echo
echo "═══ 6. 数据/稿子有没有被误提交进去（不该进）═══"
git ls-files | grep -cE "^data/|\.env$|config\.json$" | sed 's/^/  命中数: /'
git ls-files | grep -E "^data/|\.env$|config\.json$" | head -8 | sed 's/^/     /'
