#!/bin/bash
echo "═══ 1. 网关重启次数 / 运行多久 ═══"
systemctl --user show hermes-gateway -p NRestarts -p ActiveEnterTimestamp -p ExecMainStartTimestamp 2>/dev/null | sed 's/^/  /'
echo
echo "═══ 2. 最近的启动/停止历史（看多久死一次） ═══"
journalctl --user -u hermes-gateway --no-pager 2>/dev/null | grep -iE "Started|Stopped|Stopping|Killed|Failed|signal|Scheduled restart" | tail -20 | sed 's/^/  /'
echo
echo "═══ 3. 吃内存最多的 10 个进程 ═══"
ps aux --sort=-%mem | head -11 | awk '{printf "  %-6s %5s%%mem %6sMB  %s\n",$2,$4,int($6/1024),substr($0,index($0,$11),60)}'
echo
echo "═══ 4. 系统日志里的内存杀进程记录 ═══"
sudo journalctl --no-pager -k 2>/dev/null | grep -iE "out of memory|oom-kill|killed process" | tail -6 | sed 's/^/  /' || echo "  （无）"
sudo dmesg -T 2>/dev/null | grep -iE "oom|killed process" | tail -6 | sed 's/^/  /' || echo "  （读不到）"
echo
echo "═══ 5. swap 使用 ═══"
swapon --show 2>/dev/null | sed 's/^/  /'
cat /proc/sys/vm/swappiness 2>/dev/null | sed 's/^/  swappiness=/'
echo
echo "═══ 6. 有没有 oomd / earlyoom ═══"
systemctl is-active systemd-oomd 2>/dev/null | sed 's/^/  systemd-oomd: /'
command -v earlyoom >/dev/null && echo "  earlyoom: 装了"
