#!/bin/bash
echo "=== 清理空闲的 Gradle 守护进程（释放内存） ==="
before=$(free -m | awk '/^Mem:/{print $7}')
# 逐个看：CPU 接近 0 且不是正在编译才杀
for pid in $(pgrep -f "GradleDaemon" 2>/dev/null); do
  cpu=$(ps -p "$pid" -o %cpu --no-headers 2>/dev/null | tr -d ' ')
  rss=$(ps -p "$pid" -o rss --no-headers 2>/dev/null | tr -d ' ')
  cmd=$(ps -p "$pid" -o args --no-headers 2>/dev/null | cut -c1-60)
  echo "  PID $pid  CPU=${cpu}%  内存=$((rss/1024))MB"
  case "$cmd" in
    *GradleDaemon*) echo "    → 是 Gradle 守护进程，结束它"; kill "$pid" 2>/dev/null ;;
    *) echo "    → 不是守护进程，跳过" ;;
  esac
done
sleep 3
after=$(free -m | awk '/^Mem:/{print $7}')
echo
echo "  可用内存: ${before}MB → ${after}MB"
echo
echo "=== 现在的内存 ==="
free -h | sed 's/^/  /'
echo
echo "=== 还剩哪些 java ==="
ps aux | grep "[j]ava" | awk '{printf "  PID %s  %sMB  %s\n",$2,int($6/1024),substr($0,index($0,$11),60)}' || echo "  （没有 java 了）"
echo
echo "=== 网关还活着吧 ==="
systemctl --user is-active hermes-gateway
ps -p 1259 -o pid,rss --no-headers 2>/dev/null | awk '{printf "  网关 PID %s 占用 %sMB\n",$1,int($2/1024)}'
