#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ Codex 状态 ═══"
echo "  服务: $(systemctl --user is-active codex-goal.service)"
echo "  心跳: $(stat -c %y logs/codex-goal.log | cut -d. -f1)   现在: $(date '+%H:%M:%S')"
tail -4 logs/codex-goal.log | cut -c1-140
echo
echo "═══ 它最新在做的一轮（round13） ═══"
ls -t logs/round13* 2>/dev/null | head -3 | while read f; do echo "  $f"; done
tail -8 logs/round13-run.log 2>/dev/null | cut -c1-150 | sed 's/^/    /'
echo
echo "═══ 待办清单现状 ═══"
F=docs/待办清单.md
echo "  改动: $(stat -c %y $F | cut -d. -f1)"
echo "  总: $(grep -cE '^[[:space:]]*[-*] \[' $F)  已勾: $(grep -cE '^[[:space:]]*[-*] \[x\]' $F)  未勾: $(grep -cE '^[[:space:]]*[-*] \[ \]' $F)"
echo
echo "═══ 有没有新增的完成记录 ═══"
grep -nE '^[[:space:]]*[-*] \[x\]' $F | tail -6
echo
echo "═══ 它自列 20 条的状态（I 节） ═══"
grep -nE "^\- \[.\] I[0-9]+|^\- \[.\] I" $F | head -25
echo
echo "═══ 自审清单最新 ═══"
stat -c "  改动: %y  %s字节" docs/自审清单.md 2>/dev/null
tail -12 docs/自审清单.md 2>/dev/null | cut -c1-140 | sed 's/^/    /'
echo
echo "═══ 最近 40 分钟改过的文件 ═══"
find . -newermt '-40 minutes' -type f \( -name '*.js' -o -name '*.css' -o -name '*.py' -o -name '*.md' \) -not -path './.git/*' -not -path './apk/build/*' 2>/dev/null | head -10
