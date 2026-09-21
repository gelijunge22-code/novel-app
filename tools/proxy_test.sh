#!/bin/bash
sleep 6
echo "=== 代理端口 ==="
ss -ltn 2>/dev/null | grep PORT | sed 's/^/  /'
echo
echo "=== 走代理连 Google ==="
curl -s -m 25 -x http://本地代理 -o /dev/null -w "  accounts.google.com  http=%{http_code} 用时=%{time_total}s\n" https://accounts.google.com
curl -s -m 25 -x http://本地代理 -o /dev/null -w "  www.google.com       http=%{http_code} 用时=%{time_total}s\n" https://www.google.com
echo
echo "=== 顺便测 GitHub（直连应该也行） ==="
curl -s -m 25 -x http://本地代理 -o /dev/null -w "  github.com           http=%{http_code} 用时=%{time_total}s\n" https://github.com
echo
echo "=== 出口 IP（看看走没走成） ==="
curl -s -m 25 -x http://本地代理 https://api.ipify.org 2>/dev/null | sed 's/^/  走代理出口: /'; echo
curl -s -m 15 https://api.ipify.org 2>/dev/null | sed 's/^/  直连出口:   /'; echo
