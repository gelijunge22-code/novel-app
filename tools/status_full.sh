#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 活着吗 ═══"
echo "  服务: $(systemctl --user is-active codex-goal.service)"
echo "  心跳: $(stat -c %y logs/codex-goal.log | cut -d. -f1)   现在: $(date '+%H:%M:%S')"
echo
echo "═══ 2. 它现在敲的是哪条命令 ═══"
tail -6 logs/codex-goal.log | grep -E "cmd:" | tail -2 | cut -c1-190
echo
echo "═══ 3. 最新一轮在做什么（找最近的 log 文件） ═══"
ls -t logs/*.log 2>/dev/null | head -5 | while read f; do
  echo "  ── $f  ($(stat -c %y "$f" | cut -d. -f1))"
  tail -4 "$f" 2>/dev/null | cut -c1-130 | sed 's/^/      /'
done
echo
echo "═══ 4. 待办清单账目 ═══"
F=docs/待办清单.md
echo "  改动: $(stat -c %y $F | cut -d. -f1)"
echo "  总 $(grep -cE '^[[:space:]]*[-*] \[' $F) / 已勾 $(grep -cE '^[[:space:]]*[-*] \[x\]' $F) / 未勾 $(grep -cE '^[[:space:]]*[-*] \[ \]' $F)"
echo "  未勾的:"
grep -nE '^[[:space:]]*[-*] \[ \]' $F | head -8 | cut -c1-110
echo
echo "═══ 5. 自审清单最新几条 ═══"
stat -c "  改动: %y  %s字节" docs/自审清单.md
tail -16 docs/自审清单.md 2>/dev/null | cut -c1-140 | sed 's/^/    /'
echo
echo "═══ 6. 最近 30 分钟改了什么 ═══"
find . -newermt '-30 minutes' -type f \( -name '*.js' -o -name '*.css' -o -name '*.java' -o -name '*.py' -o -name '*.md' \) -not -path './.git/*' -not -path './apk/build/*' -not -path './apk/assets/www/*' 2>/dev/null | head -12
echo
echo "═══ 7. 打包了吗（2.0.3 有没有提前出） ═══"
ls -la apk/*.apk 2>/dev/null | awk '{printf "  %-28s %5.1fMB  %s %s %s\n",$9,$5/1048576,$6,$7,$8}'
cat apk/apk-version.json 2>/dev/null | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin); print('  声明版本: %s (code %s)  %s' % (d['versionName'],d['versionCode'],d['builtAt']))
except: print('  读不到')
"
echo
echo "═══ 8. 内存 ═══"
free -h | head -2 | sed 's/^/  /'
