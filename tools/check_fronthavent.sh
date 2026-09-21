#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 它现在在干什么 ═══"
echo "  心跳: $(stat -c %y logs/codex-goal.log | cut -d. -f1)   现在: $(date '+%H:%M:%S')"
grep -a "cmd:" logs/codex-goal.log | tail -4 | sed 's/.*cmd: //' | cut -c1-145 | sed 's/^/  /'
echo
echo "═══ 2. 它收到"前端大改/翻倍"指令后有没有动作 ═══"
echo "  ── 收件箱注入时间（我发的最后 4 条）:"
grep -a "注入监督人指令" logs/codex-goal.log | tail -4 | sed 's/^/     /'
echo
echo "  ── 有没有建新前端文件/目录:"
ls -la frontend/ 2>/dev/null | head -10 | sed 's/^/     /'
find frontend -newermt '-40 minutes' -type f 2>/dev/null | head -10 | sed 's/^/     /'
echo
echo "═══ 3. 最近 40 分钟改了哪些前端文件 ═══"
find frontend -newermt '-40 minutes' -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' \) 2>/dev/null | while read f; do
  printf "     %-32s %s\n" "${f#frontend/}" "$(stat -c %y "$f" | cut -d. -f1)"
done
echo
echo "═══ 4. 最近 40 分钟新报告 ═══"
ls -t docs/*.json 2>/dev/null | head -8 | while read f; do
  printf "  %-34s %s\n" "$(basename $f)" "$(stat -c %y "$f" | cut -d. -f1)"
done
echo
echo "═══ 5. 有没有关于"前端大改/翻倍"的文档/计划 ═══"
grep -rlnE "翻倍|大改|设计规范|重做前端" docs/*.md 2>/dev/null | head -6 | sed 's/^/  /'
grep -rnE "翻倍|725|726,571|12900|25,796|前端大改" docs/待办清单.md docs/进度.md 2>/dev/null | tail -6 | cut -c1-140 | sed 's/^/  /'
echo
echo "═══ 6. 前端代码量（有没有开始涨）═══"
b=$(cat frontend/index.html frontend/js/*.js frontend/css/*.css 2>/dev/null | wc -c)
l=$(cat frontend/index.html frontend/js/*.js frontend/css/*.css 2>/dev/null | wc -l)
echo "  现在: $b 字节 / $l 行     (基线 726571 / 12898, 目标 1453142 / 25796)"
