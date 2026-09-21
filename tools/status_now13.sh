#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 心跳 / 在干什么 ═══"
echo "  心跳: $(stat -c %y logs/codex-goal.log | cut -d. -f1)   现在: $(date '+%H:%M:%S')"
grep -a "cmd:" logs/codex-goal.log | tail -3 | sed 's/.*cmd: //' | cut -c1-140 | sed 's/^/  /'
echo
echo "═══ 2. 前端体积（有没有开始涨）═══"
b=$(cat frontend/index.html frontend/js/*.js frontend/css/*.css 2>/dev/null | wc -c)
l=$(cat frontend/index.html frontend/js/*.js frontend/css/*.css 2>/dev/null | wc -l)
echo "  现在: $b 字节 / $l 行"
echo "  基线: 726571 / 12898      目标: 1453142 / 25796"
echo "  完成度: $(python3 -c "print(round($b/1453142*100,1))")%"
echo
echo "═══ 3. 有没有「前端大改 · 第 N 屏」的标记 ═══"
grep -rnE "前端大改|第 1 屏|第1屏|大改 ·" docs/进度.md docs/待办清单.md 2>/dev/null | tail -8 | cut -c1-150 | sed 's/^/  /'
echo
echo "═══ 4. 最近 30 分钟新报告 ═══"
ls -t docs/*.json 2>/dev/null | head -8 | while read f; do
  printf "  %-34s %s\n" "$(basename $f)" "$(stat -c %y "$f" | cut -d. -f1)"
done
echo
echo "═══ 5. 最近 30 分钟改了哪些前端文件 ═══"
find frontend -newermt '-30 minutes' -type f 2>/dev/null | while read f; do
  printf "  %-30s %s\n" "${f#frontend/}" "$(stat -c %y "$f" | cut -d. -f1)"
done
echo
echo "═══ 6. 包 / 待办 / git ═══"
python3 -c "
import json;d=json.load(open('apk/apk-version.json'))
print('  包: %s (code %s)  %s' % (d['versionName'],d['versionCode'],d['builtAt']))
" 2>/dev/null
F=docs/待办清单.md
echo "  待办: 总 $(grep -cE '^[[:space:]]*[-*] \[' $F) / 已勾 $(grep -cE '^[[:space:]]*[-*] \[x\]' $F) / 未勾 $(grep -cE '^[[:space:]]*[-*] \[ \]' $F)"
git log --oneline -2 2>/dev/null | cut -c1-105 | sed 's/^/  /'
