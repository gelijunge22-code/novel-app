#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══════ 1. 服务与进程 ═══════"
systemctl --user is-active codex-goal.service
pgrep -af "goal_driver.py" | grep -v "bash -c" | head -2
echo
echo "═══════ 2. 目标状态 ═══════"
python3 - <<'PY'
import json,os
try:
    d=json.load(open('/home/ubuntu/novel-app/logs/goal-state.json'))
    g=d.get('goal') or d
    print(" threadId   :", g.get('threadId') or d.get('threadId'))
    print(" 状态       :", g.get('status'))
    print(" 已用 token :", f"{g.get('tokensUsed'):,}" if g.get('tokensUsed') else '?')
    print(" 预算       :", f"{g.get('tokenBudget'):,}" if g.get('tokenBudget') else '?')
    print(" 已跑秒数   :", g.get('timeUsedSeconds'))
except Exception as e:
    print(" 读不到:", e)
PY
echo
echo "═══════ 3. 它新建/改动了哪些文件 ═══════"
find . -newermt '-60 minutes' -type f ! -path './.git/*' ! -path './logs/*' ! -path './ref/*' 2>/dev/null | sort | head -40
echo
echo "═══════ 4. 进度记录 ═══════"
ls -la docs/进度.md docs/设计方案.md docs/参考项目分析.md docs/实施计划.md docs/决策记录.md 2>/dev/null | awk '{print "  ", $9, $5"B"}'
echo
echo "═══════ 5. 最近做了什么（命令） ═══════"
grep -oE '"command": "[^"]{0,110}' logs/codex-goal.log 2>/dev/null | tail -12
echo
echo "═══════ 6. 有没有报错 ═══════"
grep -cE 'error|Error|ERROR' logs/codex-goal.log 2>/dev/null
echo "--- 最近 25 行（去掉刷屏的 delta）---"
grep -vE 'textDelta|reasoning/summaryTextDelta' logs/codex-goal.log | tail -25
