#!/bin/bash
echo "═══ Codex 最近在干什么 ═══"
tail -6 /home/ubuntu/novel-app/logs/codex-goal.log 2>/dev/null | cut -c1-150
echo "  心跳: $(stat -c %y /home/ubuntu/novel-app/logs/codex-goal.log 2>/dev/null | cut -d. -f1)"
echo
echo "═══ 有没有正在跑的构建 ═══"
ps aux | grep -iE "[g]radle|[a]ssembleRelease|[b]uild.sh" | awk '{printf "  %s %s%%cpu %sMB  %s\n",$2,$3,int($6/1024),substr($0,index($0,$11),70)}'
echo
echo "═══ Gradle 守护进程状态 ═══"
ps -p 2025 -o pid,etime,rss,%cpu,args --no-headers 2>/dev/null | cut -c1-90
echo
echo "═══ 这个守护进程是空的还是有活（看它 CPU） ═══"
top -b -n1 -p 2025 2>/dev/null | tail -2 | sed 's/^/  /'
