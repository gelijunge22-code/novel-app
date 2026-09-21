#!/bin/bash
echo "=== 梯子在不在 ==="
if ss -ltn 2>/dev/null | grep -q PORT; then
  echo "  ✅ 在"
else
  echo "  ❌ 不在，拉起"
  setsid nohup /home/ubuntu/bin/本地代理 -d /home/ubuntu/.config/本地代理 > /tmp/本地代理.log 2>&1 < /dev/null &
  disown 2>/dev/null
  sleep 7
  ss -ltn 2>/dev/null | grep -q PORT && echo "  ✅ 起来了" || { echo "  ❌ 起不来"; tail -5 /tmp/本地代理.log; }
fi
echo
echo "=== 连通性 ==="
curl -s -m 15 -x http://本地代理 -o /dev/null -w "  github.com  http=%{http_code}\n" https://github.com
echo
echo "=== 申请设备码 ==="
cd /home/ubuntu/novel-app && python3 tools/gh_device.py 2>&1 | tail -8
