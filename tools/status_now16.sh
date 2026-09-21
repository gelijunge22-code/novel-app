#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 服务 / 心跳 ═══"
systemctl --user is-active codex-goal.service | sed 's/^/  服务: /'
echo "  心跳: $(stat -c %y logs/codex-goal.log | cut -d. -f1)"
echo "  现在: $(date '+%H:%M:%S')"
echo
echo "═══ 2. 我的指令注入到哪了 ═══"
grep -a "注入监督人指令" logs/codex-goal.log | tail -3 | sed 's/^/  /'
echo "  收件箱 $(stat -c%s logs/inbox.txt)B / 已投递 $(cat logs/inbox.offset)B"
echo
echo "═══ 3. 前端体积（关键）═══"
b=$(cat frontend/index.html frontend/js/*.js frontend/css/*.css 2>/dev/null | wc -c)
l=$(cat frontend/index.html frontend/js/*.js frontend/css/*.css 2>/dev/null | wc -l)
echo "  $b 字节 / $l 行    基线 726571/12898   目标 1453142/25796"
echo "  完成度 $(python3 -c "print(round($b/1453142*100,1))")%"
echo
echo "═══ 4. 大改标记 ═══"
grep -rnE "前端大改" docs/进度.md 2>/dev/null | tail -4 | cut -c1-140 | sed 's/^/  /'
echo
echo "═══ 5. 最近在干什么（最新命令 + 改的文件）═══"
grep -a "cmd:" logs/codex-goal.log | tail -3 | sed 's/.*cmd: //' | cut -c1-130 | sed 's/^/  /'
echo "  ── 最近 20 分钟改的前端文件:"
find frontend -newermt '-20 minutes' -type f 2>/dev/null | while read f; do printf "     %-28s %s\n" "${f#frontend/}" "$(stat -c %y "$f" | cut -d. -f1)"; done
echo
echo "═══ 6. 包 / 报告 ═══"
python3 -c "
import json;d=json.load(open('apk/apk-version.json'))
print('  包: %s (code %s)  %s' % (d['versionName'],d['versionCode'],d['builtAt']))
" 2>/dev/null
ls -t docs/*.json 2>/dev/null | head -5 | while read f; do printf "  %-32s %s\n" "$(basename $f)" "$(stat -c %y "$f" | cut -d. -f1)"; done
