#!/bin/bash
echo "=== 梯子在不在 ==="
if ss -ltn 2>/dev/null | grep -q PORT; then
  echo "  ✅ 代理端口 PORT 在监听"
else
  echo "  ❌ 没在跑，重新启动"
  nohup /home/ubuntu/bin/本地代理 -d /home/ubuntu/.config/本地代理 > /tmp/本地代理.log 2>&1 &
  sleep 6
  ss -ltn 2>/dev/null | grep -q PORT && echo "  ✅ 已拉起" || echo "  ❌ 起不来"
fi
echo
echo "=== 走代理连 Google / GitHub ==="
for u in https://accounts.google.com https://github.com/login; do
  curl -s -m 20 -x http://本地代理 -o /dev/null -w "  $u  http=%{http_code}  %{time_total}s\n" "$u"
done
echo
echo "=== 出口 IP ==="
curl -s -m 20 -x http://本地代理 https://api.ipify.org; echo
