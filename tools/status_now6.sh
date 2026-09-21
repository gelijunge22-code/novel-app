#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 心跳 / 现在敲什么 ═══"
echo "  心跳: $(stat -c %y logs/codex-goal.log | cut -d. -f1)   现在: $(date '+%H:%M:%S')"
echo "  服务: $(systemctl --user is-active codex-goal.service)"
grep -a "cmd:" logs/codex-goal.log | tail -4 | sed 's/.*cmd: //' | cut -c1-150 | sed 's/^/  /'
echo
echo "═══ 2. 最近 15 分钟新出的报告 / 改动 ═══"
ls -t docs/*.json 2>/dev/null | head -6 | while read f; do
  t=$(stat -c %y "$f" | cut -d. -f1)
  printf "  %-36s %s\n" "$(basename $f)" "$t"
done
echo
echo "  ── 代码改动:"
find . -newermt '-15 minutes' -type f \( -name '*.js' -o -name '*.css' -o -name '*.py' -o -name '*.java' \) -not -path './.git/*' -not -path './apk/build/*' -not -path './apk/assets/www/*' -not -path './data/*' 2>/dev/null | head -10 | sed 's/^/     /'
echo
echo "═══ 3. 5 个新功能 ═══"
for k in 故事线 常用指令 小批注 点一下看设定 章节顺序; do
  code=$(grep -rl "$k" frontend/js/*.js frontend/css/*.css server/routers/*.py 2>/dev/null | wc -l)
  printf "  %-12s 代码 %s 文件\n" "$k" "$code"
done
echo
echo "═══ 4. 待办账目 ═══"
F=docs/待办清单.md
echo "  总 $(grep -cE '^[[:space:]]*[-*] \[' $F) / 已勾 $(grep -cE '^[[:space:]]*[-*] \[x\]' $F) / 未勾 $(grep -cE '^[[:space:]]*[-*] \[ \]' $F)"
echo
echo "═══ 5. git 最新 ═══"
git log --oneline -3 2>/dev/null | cut -c1-120 | sed 's/^/  /'
echo
echo "═══ 6. 包 / 内存 ═══"
python3 -c "
import json;d=json.load(open('apk/apk-version.json'))
print('  当前包: %s (code %s)  %s' % (d['versionName'],d['versionCode'],d['builtAt']))
" 2>/dev/null
free -h | head -2 | sed 's/^/  /'
echo "  无头浏览器: $(pgrep -f 'headless' 2>/dev/null | wc -l) 个"
