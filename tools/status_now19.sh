#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 心跳 ═══"
echo "  服务: $(systemctl --user is-active codex-goal.service)"
echo "  心跳: $(stat -c %y logs/codex-goal.log | cut -d. -f1)"
date '+  现在: %H:%M:%S'
echo
echo "═══ 2. 前端体积 ═══"
B=$(cat frontend/index.html frontend/js/*.js frontend/css/*.css 2>/dev/null | wc -c)
L=$(cat frontend/index.html frontend/js/*.js frontend/css/*.css 2>/dev/null | wc -l)
echo "  $B 字节 / $L 行"
python3 -c "print('  %.1f%% (目标 1453142)' % ($B/1453142*100))"
echo
echo "═══ 3. 最新进度（顶部）═══"
head -12 docs/进度.md | grep -vE '^[[:space:]]*$' | cut -c1-140
echo
echo "═══ 4. 最近报告 ═══"
ls -t docs/*.json 2>/dev/null | head -6 | while read f; do
  printf "  %-36s %s\n" "$(basename "$f")" "$(stat -c %y "$f" | cut -d. -f1)"
done
echo
echo "═══ 5. 最近 20 分钟改过的前端文件 ═══"
find frontend -newermt '-20 minutes' -type f 2>/dev/null | head -10 | sed 's/^/  /'
echo
echo "═══ 6. 最近提交 ═══"
git log --pretty=format:'  %ad %s' --date=format:'%m-%d %H:%M' | head -4 | cut -c1-135
echo
echo
echo "═══ 7. 无头浏览器残留 ═══"
ps -eo args 2>/dev/null | grep -c -- '--headless' 
echo
echo "═══ 8. 内存 ═══"
free -m | head -2 | sed 's/^/  /'
