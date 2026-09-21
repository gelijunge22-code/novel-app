#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ Codex 状态 ═══"
systemctl --user is-active codex-goal.service
python3 -c "
import json;d=json.load(open('logs/goal-state.json'));g=d.get('goal') or d
print(' 目标:',g.get('status'),'| token:',f\"{g.get('tokensUsed'):,}\",'| 已跑:',round(g.get('timeUsedSeconds',0)/60,1),'分钟')"
echo " 最后活动: $(( ( $(date +%s) - $(stat -c %Y logs/codex-goal.log) ) / 60 )) 分钟前"
echo
echo "═══ 它最近在干什么 ═══"
grep '它说:' logs/codex-goal.log | tail -6 | cut -c1-220
echo
echo "═══ 待办清单 ═══"
if [ -f docs/待办清单.md ]; then
  echo "  已勾: $(grep -c '\[x\]' docs/待办清单.md) / 总: $(grep -c '\- \[' docs/待办清单.md)"
else
  echo "  还没建"
fi
echo
echo "═══ 自审清单 ═══"
if [ -f docs/自审清单.md ]; then
  echo "  存在（$(wc -l < docs/自审清单.md) 行）"
else
  echo "  还没建"
fi
