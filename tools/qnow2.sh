#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 状态 ═══"
systemctl --user is-active codex-goal.service
python3 -c "
import json;d=json.load(open('logs/goal-state.json'));g=d.get('goal') or d
print(' 目标:',g.get('status'),'| token:',f\"{g.get('tokensUsed'):,}\",'| 已跑:',round(g.get('timeUsedSeconds',0)/60,1),'分钟')"
echo " 最后活动: $(( ( $(date +%s) - $(stat -c %Y logs/codex-goal.log) ) / 60 )) 分钟前"
echo
echo "═══ 它最近在干什么 ═══"
grep '它说:' logs/codex-goal.log | tail -8 | cut -c1-200
echo
echo "═══ 自审清单建了吗 ═══"
if [ -f docs/自审清单.md ]; then
  ls -la docs/自审清单.md | awk '{print "  ",$9,$5"B"}'
else
  echo "  还没建"
fi
echo
echo "═══ 账 ═══"
echo " GOAL.md: $(grep -c '^- \[x\]' GOAL.md)/$(grep -c '^- \[' GOAL.md)"
grep '^## 第' docs/进度.md | tail -3 | sed 's/^/  /'
