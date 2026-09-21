#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. reader.js 的历史提交（找书设置被改之前那一版）═══"
git log --oneline --date=format:'%m-%d %H:%M' --pretty=format:'%h %ad %s' -- frontend/js/reader.js | head -14 | cut -c1-150
echo
echo
echo "═══ 2. 书设置面板的经典标志（翻页/听书分组）在哪些版本里有 ═══"
for c in $(git log --format=%h -- frontend/js/reader.js | head -12); do
  n=$(git show $c:frontend/js/reader.js 2>/dev/null | grep -c "翻页\|阅读时保持亮屏" )
  d=$(git show -s --format='%ad %s' --date=format:'%m-%d %H:%M' $c | cut -c1-60)
  echo "  $c  命中=$n  $d"
done
echo
echo "═══ 3. 现在这版长什么样（rd-quick 面板的结构）═══"
grep -n "rd-quick\|quickTab\|'set'\|排版\|翻页" frontend/js/reader.js | head -18 | cut -c1-150
