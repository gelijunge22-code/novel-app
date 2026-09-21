#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 心跳 / 在干什么 ═══"
echo "  心跳: $(stat -c %y logs/codex-goal.log | cut -d. -f1)   现在: $(date '+%H:%M:%S')"
echo "  服务: $(systemctl --user is-active codex-goal.service)"
grep -a "cmd:" logs/codex-goal.log | tail -3 | sed 's/.*cmd: //' | cut -c1-145 | sed 's/^/  /'
echo
echo "═══ 2. bug2（穿模）修了吗 ═══"
grep -nE "^\.bk-bar\{" frontend/css/base.css | sed 's/^/  /'
grep -nE "重叠|overlap|遮挡" tools/*.js tools/*.py 2>/dev/null | head -4 | cut -c1-130 | sed 's/^/  判据: /'
echo
echo "═══ 3. 最近 30 分钟新报告 ═══"
ls -t docs/*.json 2>/dev/null | head -8 | while read f; do
  printf "  %-34s %s\n" "$(basename $f)" "$(stat -c %y "$f" | cut -d. -f1)"
done
echo
echo "═══ 4. 5 个新功能（现在几个文件）═══"
for k in 故事线 常用指令 小批注 点一下看设定 章节顺序; do
  code=$(grep -rl "$k" frontend/js/*.js frontend/css/*.css server/routers/*.py 2>/dev/null | wc -l)
  rep=$(ls docs/ 2>/dev/null | grep -c "$k")
  printf "  %-12s 代码 %s 文件 / 报告 %s\n" "$k" "$code" "$rep"
done
echo
echo "═══ 5. 待办 / 包 / 提交 ═══"
F=docs/待办清单.md
echo "  待办: 总 $(grep -cE '^[[:space:]]*[-*] \[' $F) / 已勾 $(grep -cE '^[[:space:]]*[-*] \[x\]' $F) / 未勾 $(grep -cE '^[[:space:]]*[-*] \[ \]' $F)  (改动 $(stat -c %y $F | cut -d. -f1))"
python3 -c "
import json;d=json.load(open('apk/apk-version.json'))
print('  包: %s (code %s)  %s' % (d['versionName'],d['versionCode'],d['builtAt']))
" 2>/dev/null
git log --oneline -3 2>/dev/null | cut -c1-105 | sed 's/^/  /'
echo "  远程 $(git rev-parse origin/main 2>/dev/null | cut -c1-7) / 本地 $(git rev-parse HEAD 2>/dev/null | cut -c1-7)"
