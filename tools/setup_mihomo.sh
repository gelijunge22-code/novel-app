#!/bin/bash
set -e
mkdir -p /home/ubuntu/bin
cd /tmp
gunzip -f 本地代理.gz 2>/dev/null || true
chmod +x 本地代理
mv -f 本地代理 /home/ubuntu/bin/本地代理
echo "  装到 /home/ubuntu/bin/本地代理"
/home/ubuntu/bin/本地代理 -v 2>&1 | head -2
echo
echo "=== 拉订阅配置 ==="
mkdir -p /home/ubuntu/.config/本地代理
SUB='https://sub-1.smjcdh.top/smjc/api/v1/client/subscribe?token=cc003dd754af8962bc49a9c1cf24f0d4'
curl -sL -m 60 -A "clash-verge/v1.6.0" -o /home/ubuntu/.config/本地代理/config.yaml "$SUB"
ls -la /home/ubuntu/.config/本地代理/config.yaml | awk '{print "  配置大小:",$5"B"}'
head -6 /home/ubuntu/.config/本地代理/config.yaml
echo "..."
grep -cE "proxies:|^  - name:" /home/ubuntu/.config/本地代理/config.yaml 2>/dev/null | sed 's/^/  节点行数: /'
echo
echo "=== 里面有多少节点 ==="
grep -c "server:" /home/ubuntu/.config/本地代理/config.yaml 2>/dev/null | sed 's/^/  节点数: /'
