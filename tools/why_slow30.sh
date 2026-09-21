#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 第 30 轮相关日志文件（时间戳）═══"
ls -la logs/run30*.log logs/states3*.log 2>/dev/null | awk '{printf "  %-28s %8s字节  改于 %s %s\n", $9, $5, $6, $7}'
echo
echo "═══ 2. run30a.log 的进度（最后 15 行）═══"
tail -15 logs/run30a.log 2>/dev/null | cut -c1-150
echo
echo "═══ 3. run30a.log 里各步耗时（如果有记）═══"
grep -aE "开始|完成|exit=|===|耗时|秒" logs/run30a.log 2>/dev/null | tail -25 | cut -c1-140
echo
echo "═══ 4. 当前在跑的进程（node / python / chrome）═══"
ps -eo etimes,etime,pcpu,rss,args --sort=-etimes 2>/dev/null | grep -E "node|python3|chrome|e2e" | grep -v grep | head -12 | cut -c1-165
echo
echo "═══ 5. 无头浏览器数量 ═══"
ps -eo args 2>/dev/null | grep -c -- '--headless'
echo
echo "═══ 6. 系统负载 ═══"
uptime
free -m | head -2 | sed 's/^/  /'
