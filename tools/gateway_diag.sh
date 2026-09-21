#!/bin/bash
echo "═══ 1. Hermes 网关服务 ═══"
systemctl --user list-units --type=service --all 2>/dev/null | grep -iE "hermes|gateway" | head -5
echo
for s in hermes hermes-gateway hermes-agent; do
  st=$(systemctl --user is-active $s 2>/dev/null)
  [ -n "$st" ] && echo "  $s: $st"
done
echo
echo "═══ 2. 网关最近的重启记录 ═══"
journalctl --user -u hermes-gateway --no-pager -n 30 2>/dev/null | tail -20 || echo "  （没有该服务）"
echo
echo "═══ 3. 系统级 systemd 里有没有 ═══"
systemctl list-units --type=service --all 2>/dev/null | grep -iE "hermes" | head -5
echo
echo "═══ 4. 有没有被系统杀掉（OOM） ═══"
dmesg -T 2>/dev/null | grep -iE "killed process|out of memory|oom" | tail -8 || echo "  （读不到 dmesg）"
echo
echo "═══ 5. 内存情况 ═══"
free -h | sed 's/^/  /'
echo
echo "═══ 6. hermes 相关进程 ═══"
ps aux | grep -iE "[h]ermes" | awk '{printf "  %s  %s%%cpu %s%%mem  %s\n",$2,$3,$4,substr($0,index($0,$11),70)}' | head -8
