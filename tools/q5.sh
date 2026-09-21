#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 状态 ═══"
systemctl --user is-active codex-goal.service
python3 -c "
import json,os,time
d=json.load(open('logs/goal-state.json'));g=d.get('goal') or d
print(' 目标:',g.get('status'),'| token:',f\"{g.get('tokensUsed'):,}\",'| 已跑:',round(g.get('timeUsedSeconds',0)/60,1),'分钟')"
echo " 日志最后活动: $(( ( $(date +%s) - $(stat -c %Y logs/codex-goal.log) ) / 60 )) 分钟前"
echo
echo "═══ 它最近说的话 ═══"
grep "它说:" logs/codex-goal.log | tail -6 | cut -c1-330
echo
echo "═══ 最近 6 条命令 ═══"
tail -40 logs/codex-goal.log | grep "cmd:" | tail -6 | cut -c1-230
echo
echo "═══ 最近 20 分钟改了啥 ═══"
find . -newermt '-20 minutes' -type f ! -path './.git/*' ! -path './logs/*' ! -path '*__pycache__*' \
  ! -path '*/venv/*' ! -path './apk/build/*' ! -name '*.class' 2>/dev/null | head -16
echo
echo "═══ 版本 / 进度 ═══"
cat apk/apk-version.json 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);print('  APK:',d.get('versionName'),'code',d.get('versionCode'),'|',d.get('builtAt'))" 2>/dev/null
echo "  GOAL.md 打勾: $(grep -c '^- \[x\]' GOAL.md) / 28"
grep "^## 第" docs/进度.md | tail -2 | sed 's/^/  /'
[ -f DONE.md ] && echo "  ✅ DONE.md 有了" || echo "  ⏳ DONE.md 还没写"
