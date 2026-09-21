#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 心跳 / 在干什么 ═══"
echo "  心跳: $(stat -c %y logs/codex-goal.log | cut -d. -f1)   现在: $(date '+%H:%M:%S')"
echo "  服务: $(systemctl --user is-active codex-goal.service)"
grep -a "cmd:" logs/codex-goal.log | tail -3 | sed 's/.*cmd: //' | cut -c1-140 | sed 's/^/  /'
echo
echo "═══ 2. 我 15:0x 那条"收尾到此为止"指令注入了没 ═══"
grep -a "注入监督人指令" logs/codex-goal.log | tail -3 | sed 's/^/  /'
echo "  收件箱 $(stat -c%s logs/inbox.txt)B / 已投递 $(cat logs/inbox.offset)B"
echo
echo "═══ 3. 前端体积（关键指标）═══"
b=$(cat frontend/index.html frontend/js/*.js frontend/css/*.css 2>/dev/null | wc -c)
l=$(cat frontend/index.html frontend/js/*.js frontend/css/*.css 2>/dev/null | wc -l)
echo "  现在: $b 字节 / $l 行      (基线 726571/12898  目标 1453142/25796)"
echo "  完成度: $(python3 -c "print(round($b/1453142*100,1))")%"
echo
echo "═══ 4. 有没有「前端大改 · 第 N 屏」标记 ═══"
grep -rnE "前端大改" docs/进度.md docs/待办清单.md 2>/dev/null | tail -5 | cut -c1-150 | sed 's/^/  /'
echo
echo "═══ 5. 包 / 最近报告 / 提交 ═══"
python3 -c "
import json;d=json.load(open('apk/apk-version.json'))
print('  包: %s (code %s)  %s' % (d['versionName'],d['versionCode'],d['builtAt']))
" 2>/dev/null
ls -t docs/*.json 2>/dev/null | head -5 | while read f; do printf "  %-32s %s\n" "$(basename $f)" "$(stat -c %y "$f" | cut -d. -f1)"; done
git log --oneline -2 2>/dev/null | cut -c1-100 | sed 's/^/  /'
echo
echo "═══ 6. 内存 ═══"
free -h | head -2 | sed 's/^/  /'
