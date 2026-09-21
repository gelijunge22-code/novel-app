#!/bin/bash
cd /home/ubuntu/novel-app
echo "=== 服务 ==="; systemctl --user is-active codex-goal.service
echo "=== 目标 ==="
python3 -c "
import json;d=json.load(open('logs/goal-state.json'));g=d.get('goal') or d
print(' 状态:',g.get('status'),'| token:',f\"{g.get('tokensUsed'):,}\",'| 已跑:',round(g.get('timeUsedSeconds',0)/60,1),'分钟')"
echo " 最后活动: $(( ( $(date +%s) - $(stat -c %Y logs/codex-goal.log) ) / 60 )) 分钟前"
echo "=== 账 ==="
echo " GOAL.md: $(grep -c '^- \[x\]' GOAL.md)/$(grep -c '^- \[' GOAL.md) 已勾"
if [ -f DONE.md ]; then echo " DONE.md 存在（$(wc -l < DONE.md) 行）"; fi
echo "=== APK ==="
python3 -c "
import json;d=json.load(open('apk/apk-version.json'))
print(' ',d.get('versionName'),'code',d.get('versionCode'),'|',round(d.get('size',0)/1048576,1),'MB |',d.get('builtAt'))"
echo "=== 它最近说的 ==="
grep '它说:' logs/codex-goal.log | tail -4 | cut -c1-190
