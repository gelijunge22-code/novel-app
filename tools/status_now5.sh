#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 活着 / 在干什么 ═══"
echo "  服务: $(systemctl --user is-active codex-goal.service)"
echo "  心跳: $(stat -c %y logs/codex-goal.log | cut -d. -f1)   现在: $(date '+%H:%M:%S')"
grep -a "cmd:" logs/codex-goal.log | tail -3 | sed 's/.*cmd: //' | cut -c1-140 | sed 's/^/  /'
echo
echo "═══ 2. 5 个新功能进度（代码 + 实测报告）═══"
for k in 故事线 常用指令 小批注 点一下看设定 章节顺序; do
  code=$(grep -rl "$k" frontend/js/*.js frontend/css/*.css server/routers/*.py 2>/dev/null | wc -l)
  rep=$(ls docs/ 2>/dev/null | grep -c "$k")
  printf "  %-12s 代码 %s 文件 / 报告 %s 份\n" "$k" "$code" "$rep"
done
echo
echo "═══ 3. 最新实测报告（时间倒序）═══"
ls -t docs/*.json 2>/dev/null | head -10 | while read f; do
  printf "  %-34s %s\n" "$(basename $f)" "$(stat -c %y "$f" | cut -d. -f1)"
done
echo
echo "═══ 4. 待办账目 ═══"
F=docs/待办清单.md
echo "  总 $(grep -cE '^[[:space:]]*[-*] \[' $F) / 已勾 $(grep -cE '^[[:space:]]*[-*] \[x\]' $F) / 未勾 $(grep -cE '^[[:space:]]*[-*] \[ \]' $F)"
echo "  未勾的关键项:"
grep -nE '^[[:space:]]*[-*] \[ \]' $F | tail -8 | cut -c1-118 | sed 's/^/    /'
echo
echo "═══ 5. 最近 20 分钟改了什么 ═══"
find . -newermt '-20 minutes' -type f \( -name '*.js' -o -name '*.css' -o -name '*.py' -o -name '*.md' \) -not -path './.git/*' -not -path './apk/build/*' -not -path './apk/assets/www/*' -not -path './data/*' 2>/dev/null | head -12 | sed 's/^/  /'
echo
echo "═══ 6. 包（不该有新包）═══"
python3 -c "
import json;d=json.load(open('apk/apk-version.json'))
print('  当前包: %s (code %s)  %s' % (d['versionName'],d['versionCode'],d['builtAt']))
" 2>/dev/null
echo
echo "═══ 7. git 推到哪了 ═══"
git log --oneline -4 2>/dev/null | sed 's/^/  /'
echo "  远程: $(git rev-parse origin/main 2>/dev/null | cut -c1-7) / 本地: $(git rev-parse HEAD 2>/dev/null | cut -c1-7)"
