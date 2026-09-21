#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 服务状态（上次看到 activating，要确认）═══"
systemctl --user status codex-goal.service --no-pager 2>/dev/null | head -12 | sed 's/^/  /'
echo
echo "═══ 2. 心跳 ═══"
echo "  日志最后改动: $(stat -c %y logs/codex-goal.log | cut -d. -f1)"
echo "  现在:         $(date '+%Y-%m-%d %H:%M:%S')"
echo "  日志大小:     $(stat -c%s logs/codex-goal.log) 字节"
echo
echo "═══ 3. 最近 6 条命令 ═══"
grep -a "cmd:" logs/codex-goal.log | tail -6 | sed 's/.*cmd: //' | cut -c1-130 | sed 's/^/  /'
echo
echo "═══ 4. 最后几行原始日志 ═══"
tail -8 logs/codex-goal.log | cut -c1-140 | sed 's/^/  /'
echo
echo "═══ 5. 前端体积 / 大改标记 ═══"
b=$(cat frontend/index.html frontend/js/*.js frontend/css/*.css 2>/dev/null | wc -c)
echo "  前端: $b 字节 (基线 726571 / 目标 1453142)"
grep -rnE "前端大改" docs/进度.md 2>/dev/null | tail -3 | cut -c1-140 | sed 's/^/  /'
echo
echo "═══ 6. 有没有卡住的迹象（进程还在吗） ═══"
ps aux | grep -E "[c]odex" | awk '{printf "  PID %s %s%%cpu %sMB %s\n",$2,$3,int($6/1024),substr($0,index($0,$11),60)}' | head -5
