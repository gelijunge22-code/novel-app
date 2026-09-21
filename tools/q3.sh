#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 还活着吗 ═══"
systemctl --user is-active codex-goal.service
python3 -c "
import json,os,time
d=json.load(open('logs/goal-state.json'));g=d.get('goal') or d
print(' 目标:',g.get('status'),'| token:',f\"{g.get('tokensUsed'):,}\",'| 已跑:',round(g.get('timeUsedSeconds',0)/60,1),'分钟')"
LASTMOD=$(stat -c %Y logs/codex-goal.log)
echo " 日志最后活动: $(( ($(date +%s) - LASTMOD) / 60 )) 分钟前"
echo
echo "═══ 2. 它收到我的指令了吗（最近有没有转向） ═══"
grep -oE '"command": "[^"]{0,120}' logs/codex-goal.log | tail -6
echo
echo "═══ 3. 最近 30 分钟改了什么 ═══"
find . -newermt '-30 minutes' -type f ! -path './.git/*' ! -path './logs/*' ! -path '*__pycache__*' ! -path '*/venv/*' 2>/dev/null | head -20
echo
echo "═══ 4. 后端下沉有没有动静 ═══"
grep -nE "127.0.0.1|localhost|localhostPort|startServer|Chaquopy|python" apk/src/com/nbapp/desk/MainActivity.java 2>/dev/null | head -8
ls -la apk/assets/ 2>/dev/null | head
echo "  APK 版本:"; cat apk/apk-version.json 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);print('   ',d.get('versionName'),'code',d.get('versionCode'),d.get('builtAt'))" 2>/dev/null
echo
echo "═══ 5. GOAL.md 打勾了吗 ═══"
echo "  已勾: $(grep -c '^- \[x\]' GOAL.md) / 总: $(grep -c '^- \[' GOAL.md)"
echo
echo "═══ 6. 进度到第几轮 ═══"
grep "^## 第" docs/进度.md | tail -3
[ -f DONE.md ] && echo " ✅ DONE.md 已写" || echo " ⏳ DONE.md 未写"
