#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 状态 ═══"
systemctl --user is-active codex-goal.service
python3 -c "
import json;d=json.load(open('logs/goal-state.json'));g=d.get('goal') or d
print(' 目标:',g.get('status'),'| token:',f\"{g.get('tokensUsed'):,}\",'| 已跑:',round(g.get('timeUsedSeconds',0)/60,1),'分钟')"
echo " 日志最后活动: $(( ( $(date +%s) - $(stat -c %Y logs/codex-goal.log) ) / 60 )) 分钟前"
echo
echo "═══ 它最近说的话 ═══"
grep "它说:" logs/codex-goal.log | tail -6 | cut -c1-300
echo
echo "═══ 最近命令 ═══"
tail -80 logs/codex-goal.log | grep "cmd:" | tail -6 | cut -c1-200
echo
echo "═══ 有没有"离线/ondevice"的产物 ═══"
find . -newermt '-60 minutes' \( -name '*offline*' -o -name '*ondevice*' -o -name '*飞行*' -o -name '*device*' \) ! -path './.git/*' ! -path '*/venv/*' ! -path './apk/.gradle/*' 2>/dev/null | head -12
echo
echo "═══ 最近 25 分钟改了什么 ═══"
find . -newermt '-25 minutes' -type f ! -path './.git/*' ! -path './logs/*' ! -path '*__pycache__*' \
  ! -path '*/venv/*' ! -path './apk/.gradle/*' ! -path './apk/build/*' ! -name '*.class' ! -name '*.lock' 2>/dev/null | head -16
echo
echo "═══ 账 ═══"
echo "  GOAL.md: $(grep -c '^- \[x\]' GOAL.md)/28"
grep "^## 第" docs/进度.md | tail -2 | sed 's/^/  /'
[ -f DONE.md ] && echo "  ✅ DONE.md" || echo "  ⏳ DONE.md 未写"
