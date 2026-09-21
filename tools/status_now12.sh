#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 心跳 / 在干什么 ═══"
echo "  心跳: $(stat -c %y logs/codex-goal.log | cut -d. -f1)   现在: $(date '+%H:%M:%S')"
grep -a "cmd:" logs/codex-goal.log | tail -3 | sed 's/.*cmd: //' | cut -c1-140 | sed 's/^/  /'
echo
echo "═══ 2. 待办清单还剩哪些（未勾的逐条）═══"
F=docs/待办清单.md
echo "  总 $(grep -cE '^[[:space:]]*[-*] \[' $F) / 已勾 $(grep -cE '^[[:space:]]*[-*] \[x\]' $F) / 未勾 $(grep -cE '^[[:space:]]*[-*] \[ \]' $F)   (改动 $(stat -c %y $F | cut -d. -f1))"
grep -nE '^[[:space:]]*[-*] \[ \]' $F | cut -c1-125 | sed 's/^/  /'
echo
echo "═══ 3. 最近 30 分钟报告 ═══"
ls -t docs/*.json 2>/dev/null | head -10 | while read f; do
  printf "  %-34s %s\n" "$(basename $f)" "$(stat -c %y "$f" | cut -d. -f1)"
done
echo
echo "═══ 4. 5 个新功能实测结果 ═══"
python3 -c "
import json
d=json.load(open('docs/新功能实测.json'))
print('  时间:',d.get('at'))
print('  总:',d.get('total'),'通过:',d.get('passed'),'失败:',len(d.get('fails') or []))
for s in (d.get('steps') or [])[:6]:
    print('   ',('✓' if s.get('ok') else '✗'),s.get('name'))
" 2>/dev/null
echo
echo "═══ 5. git / 包 ═══"
git log --oneline -3 2>/dev/null | cut -c1-110 | sed 's/^/  /'
python3 -c "
import json;d=json.load(open('apk/apk-version.json'))
print('  包: %s (code %s)  %s' % (d['versionName'],d['versionCode'],d['builtAt']))
" 2>/dev/null
