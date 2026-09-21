#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 它那边的真实 token 预算 ═══"
python3 -c "
import json;d=json.load(open('logs/goal-state.json'));g=d.get('goal') or d
print('  tokenBudget:', g.get('tokenBudget'))
print('  tokensUsed :', f\"{g.get('tokensUsed'):,}\")
print('  剩余       :', f\"{g.get('tokenBudget',0) - g.get('tokensUsed',0):,}\" if g.get('tokenBudget') else '不限')
print('  状态       :', g.get('status'))"
echo
echo "═══ 2. 我发给它的指令里有没有提过 400万/4,000,000 ═══"
grep -n "400万\|4,000,000\|4000000\|4M" logs/inbox.txt 2>/dev/null | head -5 || echo "  收件箱里没有"
echo
echo "═══ 3. 驱动器里 GOAL_TOKEN_BUDGET 设的多少 ═══"
grep -n "GOAL_TOKEN_BUDGET" tools/goal_driver.py /home/ubuntu/.config/systemd/user/codex-goal.service | head -4
echo
echo "═══ 4. 旧会话里有没有对它说过 400 万 ═══"
python3 - <<'PY'
p='/home/ubuntu/.codex/sessions/2026/09/19/rollout-2026-09-19T13-45-19-01a0b832-9d5e-7362-8328-53a3ac726e69.jsonl'
n=0
for line in open(p,encoding='utf-8',errors='ignore'):
    if '400万' in line or '4,000,000' in line:
        n+=1
print('  会话里命中:', n, '次')
PY
