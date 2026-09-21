#!/bin/bash
echo "=== 代理端口 ==="
ss -ltn 2>/dev/null | grep -E "PORT|7891|1080|7897" || echo "  没有代理在监听"
echo
echo "=== 直连 google ==="
curl -s -m 8 -o /dev/null -w "  google.com    http=%{http_code} 用时=%{time_total}s\n" https://accounts.google.com 2>&1
echo "=== 直连 github ==="
curl -s -m 8 -o /dev/null -w "  github.com    http=%{http_code} 用时=%{time_total}s\n" https://github.com 2>&1
echo "=== 走代理连 google ==="
curl -s -m 12 -x http://本地代理 -o /dev/null -w "  代理->google  http=%{http_code} 用时=%{time_total}s\n" https://accounts.google.com 2>&1
echo
echo "=== 有没有 本地代理/clash 进程 ==="
pgrep -af "本地代理|clash|v2ray|xray" | head -3 || echo "  没有代理进程"
echo
echo "=== PORT 是谁在用（如果有） ==="
ss -ltnp 2>/dev/null | grep PORT | head -2
