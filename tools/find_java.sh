#!/bin/bash
echo "═══ PID 2025 到底是什么 ═══"
ps -p 2025 -o pid,etime,rss,args --no-headers 2>/dev/null | cut -c1-200
echo
echo "═══ 所有 java 进程 ═══"
ps aux | grep "[j]ava" | awk '{printf "  PID %-6s %5s%%mem %6sMB  %s\n",$2,$4,int($6/1024),substr($0,index($0,$11),90)}'
echo
echo "═══ 有没有 gradle 守护进程 ═══"
ps aux | grep -i "[g]radle" | awk '{printf "  PID %-6s %6sMB  %s\n",$2,int($6/1024),substr($0,index($0,$11),80)}'
echo
echo "═══ 内存现状 ═══"
free -m | sed 's/^/  /'
echo
echo "═══ gradle 配置 ═══"
find /home/ubuntu/novel-app -name "gradle.properties" -not -path "*/build/*" 2>/dev/null | head -3 | while read f; do
  echo "  $f:"; cat "$f" 2>/dev/null | sed 's/^/    /'
done
echo
echo "═══ ~/.gradle/gradle.properties ═══"
cat /home/ubuntu/.gradle/gradle.properties 2>/dev/null | sed 's/^/  /' || echo "  （没有）"
