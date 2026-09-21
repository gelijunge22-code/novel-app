#!/bin/bash
echo "═══ 1. Codex 状态 ═══"
systemctl --user is-active codex-goal.service
python3 -c "
import json;d=json.load(open('/home/ubuntu/novel-app/logs/goal-state.json'));g=d.get('goal') or d
print(' 目标:',g.get('status'),'| token:',f\"{g.get('tokensUsed'):,}\",'| 已跑:',round(g.get('timeUsedSeconds',0)/60,1),'分钟')"
echo " 最后活动: $(( ( $(date +%s) - $(stat -c %Y /home/ubuntu/novel-app/logs/codex-goal.log) ) / 60 )) 分钟前"
echo "--- 它最近在干 ---"
grep '它说:' /home/ubuntu/novel-app/logs/codex-goal.log | tail -5 | cut -c1-190
echo "--- 待办清单 ---"
echo "  已勾: $(grep -c '\[x\]' /home/ubuntu/novel-app/docs/待办清单.md 2>/dev/null) / $(grep -c '\- \[' /home/ubuntu/novel-app/docs/待办清单.md 2>/dev/null)"
ls -la /home/ubuntu/novel-app/docs/自审清单.md 2>/dev/null | awk '{print "  自审清单:",$5"B"}' || echo "  自审清单: 还没建"
echo
echo "═══ 2. 代理软件在不在 ═══"
for b in 本地代理 clash clash-meta xray v2ray sing-box; do
  p=$(which $b 2>/dev/null); [ -n "$p" ] && echo "  ✅ $b -> $p"
done
ls -la /usr/local/bin/本地代理 /opt/本地代理/本地代理 /usr/bin/本地代理 2>/dev/null | head -3
find / -maxdepth 4 -name "本地代理" -o -maxdepth 4 -name "clash" -type f 2>/dev/null | head -5
echo
echo "═══ 3. 之前配梯子留下的痕迹 ═══"
ls -la /home/ubuntu/.config/本地代理 /home/ubuntu/.config/clash /etc/本地代理 2>/dev/null | head -8
ls /home/ubuntu/*.yaml /home/ubuntu/config*.yaml 2>/dev/null | head -5
