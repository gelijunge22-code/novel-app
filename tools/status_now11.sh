#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 心跳 / 在干什么 ═══"
echo "  心跳: $(stat -c %y logs/codex-goal.log | cut -d. -f1)   现在: $(date '+%H:%M:%S')"
echo "  服务: $(systemctl --user is-active codex-goal.service)"
grep -a "cmd:" logs/codex-goal.log | tail -3 | sed 's/.*cmd: //' | cut -c1-145 | sed 's/^/  /'
echo
echo "═══ 2. 最近 40 分钟新报告 ═══"
ls -t docs/*.json 2>/dev/null | head -10 | while read f; do
  printf "  %-34s %s\n" "$(basename $f)" "$(stat -c %y "$f" | cut -d. -f1)"
done
echo
echo "═══ 3. 5 个新功能（代码/报告）═══"
for k in 故事线 常用指令 小批注 点一下看设定 章节顺序; do
  code=$(grep -rl "$k" frontend/js/*.js frontend/css/*.css server/routers/*.py 2>/dev/null | wc -l)
  rep=$(ls docs/ 2>/dev/null | grep -c "$k")
  printf "  %-12s 代码 %s 文件 / 报告 %s\n" "$k" "$code" "$rep"
done
echo
echo "  ── 5 个新功能的测试脚本:"
ls -la tools/e2e-new5.js 2>/dev/null | awk '{print "     e2e-new5.js",$5,"字节",$6,$7,$8}'
ls -t logs/*new5* 2>/dev/null | head -3 | while read f; do echo "     $(basename $f) $(stat -c %y "$f" | cut -d. -f1)"; done
echo
echo "═══ 4. 待办 / 包 / git ═══"
F=docs/待办清单.md
echo "  待办: 总 $(grep -cE '^[[:space:]]*[-*] \[' $F) / 已勾 $(grep -cE '^[[:space:]]*[-*] \[x\]' $F) / 未勾 $(grep -cE '^[[:space:]]*[-*] \[ \]' $F)  (改动 $(stat -c %y $F | cut -d. -f1))"
python3 -c "
import json;d=json.load(open('apk/apk-version.json'))
print('  包: %s (code %s)  %s' % (d['versionName'],d['versionCode'],d['builtAt']))
" 2>/dev/null
git log --oneline -3 2>/dev/null | cut -c1-110 | sed 's/^/  /'
echo "  远程 $(git rev-parse origin/main 2>/dev/null | cut -c1-7) / 本地 $(git rev-parse HEAD 2>/dev/null | cut -c1-7)"
echo
echo "═══ 5. 内存 ═══"
free -h | head -2 | sed 's/^/  /'
