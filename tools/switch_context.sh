#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 备份旧状态 + 提交交接说明 ═══"
TS=$(date +%Y%m%d-%H%M%S)
cp logs/goal-state.json "logs/goal-state.json.bak-$TS" 2>/dev/null && echo "  ✅ 旧线程 id 已备份到 logs/goal-state.json.bak-$TS"
git add -A && git commit -q -m "交接说明（新会话的 KICKOFF）：前端/后端结构 + 剩余两件 + 收尾步骤 + 规矩" && echo "  ✅ 交接说明已提交: $(git log -1 --pretty=format:'%h %s' | cut -c1-70)"

echo
echo "═══ 2. 清掉线程 id（让驱动器新建线程，读 KICKOFF.md）═══"
mv logs/goal-state.json logs/goal-state.to-be-ignored 2>/dev/null && echo "  ✅ 旧 state 已移开（驱动器下次启动会新建线程）"

echo
echo "═══ 3. 重启驱动器（用户已批准；这是切换上下文的那一下）═══"
systemctl --user restart codex-goal.service
sleep 25
echo "  服务状态: $(systemctl --user is-active codex-goal.service)"

echo
echo "═══ 4. 看它有没有新建线程 ═══"
sleep 15
tail -25 logs/codex-goal.log | grep -aE "新建线程|已恢复线程|恢复时指定|注入|收件箱|对齐目标|error|blocked" | tail -10 | cut -c1-150 | sed 's/^/  /'
echo
echo "  新的 state:"; cat logs/goal-state.json 2>/dev/null | python3 -c "import sys,json;d=json.load(sys.stdin);print('    threadId =',d.get('threadId'))" 2>/dev/null || echo "    (还没写)"
echo "  旧 threadId = 01a0b832-9d5e-7362-8328-53a3ac726e69"
