#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 心跳 / 在干什么 ═══"
echo "  心跳: $(stat -c %y logs/codex-goal.log | cut -d. -f1)   现在: $(date '+%H:%M:%S')"
echo "  服务: $(systemctl --user is-active codex-goal.service)"
grep -a "cmd:" logs/codex-goal.log | tail -4 | sed 's/.*cmd: //' | cut -c1-150 | sed 's/^/  /'
echo
echo "═══ 2. 最近 20 分钟的新报告 ═══"
ls -t docs/*.json 2>/dev/null | head -8 | while read f; do
  printf "  %-36s %s\n" "$(basename $f)" "$(stat -c %y "$f" | cut -d. -f1)"
done
echo
echo "  ── 夜间体检报告说了什么:"
python3 -c "
import json
try:
    d=json.load(open('docs/夜间体检报告.json'))
    s=json.dumps(d, ensure_ascii=False)
    print('   ',s[:600])
except Exception as e: print('   读不到:',e)
" 2>/dev/null
echo
echo "═══ 3. 5 个新功能 ═══"
for k in 故事线 常用指令 小批注 点一下看设定 章节顺序; do
  code=$(grep -rl "$k" frontend/js/*.js frontend/css/*.css server/routers/*.py 2>/dev/null | wc -l)
  printf "  %-12s %s 个文件\n" "$k" "$code"
done
echo
echo "═══ 4. 待办 ═══"
F=docs/待办清单.md
echo "  总 $(grep -cE '^[[:space:]]*[-*] \[' $F) / 已勾 $(grep -cE '^[[:space:]]*[-*] \[x\]' $F) / 未勾 $(grep -cE '^[[:space:]]*[-*] \[ \]' $F)"
grep -nE '^[[:space:]]*[-*] \[ \]' $F | tail -6 | cut -c1-115 | sed 's/^/    /'
echo
echo "═══ 5. git / 包 / 内存 ═══"
git log --oneline -2 2>/dev/null | cut -c1-110 | sed 's/^/  /'
python3 -c "
import json;d=json.load(open('apk/apk-version.json'))
print('  包: %s (code %s)  %s' % (d['versionName'],d['versionCode'],d['builtAt']))
" 2>/dev/null
free -h | head -2 | sed 's/^/  /'
echo "  无头浏览器: $(pgrep -f 'headless' 2>/dev/null | wc -l) 个"
