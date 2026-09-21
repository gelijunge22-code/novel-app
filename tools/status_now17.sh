#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 心跳 / 在干什么 ═══"
echo "  心跳: $(stat -c %y logs/codex-goal.log | cut -d. -f1)   现在: $(date '+%H:%M:%S')"
echo "  服务: $(systemctl --user is-active codex-goal.service)"
grep -a "cmd:" logs/codex-goal.log | tail -3 | sed 's/.*cmd: //' | cut -c1-135 | sed 's/^/  /'
echo
echo "═══ 2. 前端体积（大改进度）═══"
b=$(cat frontend/index.html frontend/js/*.js frontend/css/*.css 2>/dev/null | wc -c)
l=$(cat frontend/index.html frontend/js/*.js frontend/css/*.css 2>/dev/null | wc -l)
echo "  $b 字节 / $l 行   基线 726571/12898  目标 1453142/25796"
python3 -c "print('  完成度 %.1f%%' % ($b/1453142*100))"
echo
echo "═══ 3. 屏进度 ═══"
grep -nE "第 ?[0-9]+ ?屏" docs/进度.md 2>/dev/null | head -10 | cut -c1-135 | sed 's/^/  /'
echo
echo "═══ 4. 大设置有没有搬回旧版 ═══"
grep -rnE "搬回|恢复原|旧版设置|改前" docs/进度.md docs/待办清单.md 2>/dev/null | tail -5 | cut -c1-140 | sed 's/^/  /'
echo
echo "═══ 5. 最近 25 分钟改的前端文件 ═══"
find frontend -newermt '-25 minutes' -type f 2>/dev/null | while read f; do printf "  %-26s %s\n" "${f#frontend/}" "$(stat -c %y "$f" | cut -d. -f1)"; done
echo
echo "═══ 6. 最近 25 分钟新报告/提交 ═══"
ls -t docs/*.json 2>/dev/null | head -5 | while read f; do printf "  %-30s %s\n" "$(basename $f)" "$(stat -c %y "$f" | cut -d. -f1)"; done
git log --oneline -4 2>/dev/null | cut -c1-105 | sed 's/^/  /'
echo "  远程 $(git rev-parse origin/main 2>/dev/null | cut -c1-7) / 本地 $(git rev-parse HEAD 2>/dev/null | cut -c1-7)"
echo
echo "═══ 7. 内存 ═══"
free -h | head -2 | sed 's/^/  /'
