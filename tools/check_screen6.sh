#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 心跳 ═══"
echo "  服务: $(systemctl --user is-active codex-goal.service)"
echo "  心跳: $(stat -c %y logs/codex-goal.log | cut -d. -f1)"
date '+  现在: %H:%M:%S'
echo
echo "═══ 2. 第 6 屏开了没？（进度文档里搜"第 6 屏"）═══"
grep -n "第 6 屏\|第6屏" docs/进度.md | head -6 | cut -c1-150
echo
echo "═══ 3. 进度文档顶部 8 行 ═══"
head -8 docs/进度.md | grep -vE '^[[:space:]]*$' | cut -c1-145
echo
echo "═══ 4. 阅读器相关文件最近改动时间 ═══"
for f in frontend/js/reader.js frontend/css/reader.css frontend/index.html; do
  printf "  %-28s %s\n" "$f" "$(stat -c %y "$f" | cut -d. -f1)"
done
echo
echo "═══ 5. 最近 30 分钟改过的所有前端文件 ═══"
find frontend -newermt '-30 minutes' -type f 2>/dev/null | head -12 | sed 's/^/  /'
echo
echo "═══ 6. 最近报告 ═══"
ls -t docs/*.json 2>/dev/null | head -8 | while read f; do
  printf "  %-36s %s\n" "$(basename "$f")" "$(stat -c %y "$f" | cut -d. -f1)"
done
echo
echo "═══ 7. 它现在正在跑的命令 ═══"
grep -a "cmd:" logs/codex-goal.log | tail -3 | sed 's/.*cmd: //' | cut -c1-140
echo
echo "═══ 8. 前端体积 ═══"
B=$(cat frontend/index.html frontend/js/*.js frontend/css/*.css 2>/dev/null | wc -c)
L=$(cat frontend/index.html frontend/js/*.js frontend/css/*.css 2>/dev/null | wc -l)
echo "  $B 字节 / $L 行"
python3 -c "print('  %.1f%% (目标 1453142)' % ($B/1453142*100))"
