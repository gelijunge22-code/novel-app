#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 心跳 / 在干什么 ═══"
echo "  心跳: $(stat -c %y logs/codex-goal.log | cut -d. -f1)   现在: $(date '+%H:%M:%S')"
echo "  服务: $(systemctl --user is-active codex-goal.service)"
grep -a "cmd:" logs/codex-goal.log | tail -3 | sed 's/.*cmd: //' | cut -c1-130 | sed 's/^/  /'
echo
echo "═══ 2. 前端体积 ═══"
b=$(cat frontend/index.html frontend/js/*.js frontend/css/*.css 2>/dev/null | wc -c)
l=$(cat frontend/index.html frontend/js/*.js frontend/css/*.css 2>/dev/null | wc -l)
echo "  $b 字节 / $l 行   基线 726571/12898  目标 1453142/25796"
python3 -c "print('  完成度 %.1f%%' % ($b/1453142*100))"
echo
echo "═══ 3. 进度文档最新记的（顶部） ═══"
head -30 docs/进度.md 2>/dev/null | grep -vE "^\s*$" | head -14 | cut -c1-140 | sed 's/^/  /'
echo
echo "═══ 4. 我报的 A–E 修了吗 ═══"
echo "  ── A 阅读器上下变白：chrome-off 那边有没有让正文撑满"
grep -nE "chrome-off" frontend/css/reader.css | head -4 | cut -c1-140 | sed 's/^/     /'
echo "  ── B 小方块压标题：chat-book / 顶栏改动"
grep -nE "chat-book|bookctx" frontend/index.html frontend/css/*.css | head -4 | cut -c1-130 | sed 's/^/     /'
echo "  ── C 横向溢出 padding"
grep -nE "padding-inline|mode-row|run-row" frontend/css/panels.css frontend/css/components.css 2>/dev/null | head -5 | cut -c1-130 | sed 's/^/     /'
echo "  ── D 开发术语（落盘/收件箱）还在不在界面文案里"
grep -rnE "落盘|收件箱等你确认" frontend/js/chat.js frontend/js/studio.js 2>/dev/null | head -4 | cut -c1-130 | sed 's/^/     /'
echo
echo "═══ 5. 最近 30 分钟改的前端文件 ═══"
find frontend -newermt '-30 minutes' -type f 2>/dev/null | while read f; do printf "  %-26s %s\n" "${f#frontend/}" "$(stat -c %y "$f" | cut -d. -f1)"; done
echo
echo "═══ 6. 最近 30 分钟新报告 ═══"
ls -t docs/*.json 2>/dev/null | head -6 | while read f; do printf "  %-30s %s\n" "$(basename $f)" "$(stat -c %y "$f" | cut -d. -f1)"; done
