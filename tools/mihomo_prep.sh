#!/bin/bash
cd /home/ubuntu/.config/本地代理
# 安全：只监听本机，不对外开代理端口
sed -i "s/^allow-lan: true/allow-lan: false/" config.yaml
sed -i "s/^bind-address: '\*'/bind-address: '127.0.0.1'/" config.yaml
grep -E "^mixed-port|^allow-lan|^bind-address|^external-controller" config.yaml | sed 's/^/  /'
echo
echo "=== 语法检查 ==="
/home/ubuntu/bin/本地代理 -t -d /home/ubuntu/.config/本地代理 2>&1 | tail -5
