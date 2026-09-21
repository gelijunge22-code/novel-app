#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 驱动器里注入的判定逻辑 ═══"
grep -nE "inbox|offset|注入" tools/goal_driver.py | head -24 | cut -c1-150 | sed 's/^/  /'
echo
echo "═══ 2. 驱动器日志里还有没有 inbox 相关记录 ═══"
grep -aE "inbox|注入" logs/codex-goal.log | tail -6 | cut -c1-150 | sed 's/^/  /'
echo
echo "═══ 3. 驱动器进程活着吗、是哪一版 ═══"
ps -eo pid,etime,args | grep "[g]oal_driver" | cut -c1-140 | sed 's/^/  /'
echo
echo "═══ 4. 它当前这个"轮"跑了多久（从最后一条注入算起） ═══"
last=$(grep -a "注入监督人指令" logs/codex-goal.log | tail -1 | sed 's/^\[\([0-9:]*\)\].*/\1/')
echo "  最后注入: $last"
echo "  现在:     $(date '+%H:%M:%S')"
python3 -c "
from datetime import datetime
a=datetime.strptime('$last','%H:%M:%S')
b=datetime.strptime('$(date '+%H:%M:%S')','%H:%M:%S')
d=(b-a).seconds
print('  已经等了 %d 分钟' % (d//60))
" 2>/dev/null
echo
echo "═══ 5. 它这一轮在重复跑什么（看最近 20 条命令的去重）═══"
grep -a "cmd:" logs/codex-goal.log | tail -20 | sed 's/.*cmd: //' | cut -c1-60 | sort | uniq -c | sort -rn | head -6 | sed 's/^/  /'
