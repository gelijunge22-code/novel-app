#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 状态 ═══"
systemctl --user is-active codex-goal.service
python3 -c "
import json;d=json.load(open('logs/goal-state.json'));g=d.get('goal') or d
print(' 目标:',g.get('status'),'| token:',f\"{g.get('tokensUsed'):,}\",'| 已跑:',round(g.get('timeUsedSeconds',0)/60,1),'分钟')"
echo
echo "═══ 进度记录有第几轮 ═══"
grep -n "^## 第" docs/进度.md 2>/dev/null | tail -8
echo
echo "═══ 最新一轮写了什么 ═══"
awk '/^## 第/{n=NR} END{}' docs/进度.md >/dev/null 2>&1
LAST=$(grep -n "^## 第" docs/进度.md | tail -1 | cut -d: -f1)
tail -n +$LAST docs/进度.md 2>/dev/null | head -35
echo
echo "═══ 最近动作 ═══"
grep -vE 'textDelta' logs/codex-goal.log | grep -oE '"command": "[^"]{0,110}' | tail -6
echo
echo "═══ 前端有没有新东西 ═══"
find frontend -newermt '-40 minutes' -type f 2>/dev/null | head -15
echo
echo "═══ APK 侧有没有动静 ═══"
find apk -newermt '-100 minutes' -type f ! -name '*.apk' 2>/dev/null | head -10
