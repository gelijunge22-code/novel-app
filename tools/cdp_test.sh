#!/bin/bash
pkill -f "gh-g5-profile" 2>/dev/null
sleep 1
rm -rf /tmp/cdptest
echo "=== 启动真 Chrome（带调试端口） ==="
xvfb-run -a --server-args="-screen 0 1366x900x24" \
  /usr/bin/google-chrome --no-sandbox --disable-gpu \
  --remote-debugging-port=9339 \
  --remote-debugging-address=127.0.0.1 \
  --no-first-run --no-default-browser-check \
  --user-data-dir=/tmp/cdptest \
  --proxy-server=http://本地代理 \
  about:blank > /tmp/cdptest.log 2>&1 &
for i in $(seq 1 30); do
  sleep 1
  r=$(curl -s -m 3 http://127.0.0.1:9339/json/version 2>/dev/null)
  if [ -n "$r" ]; then echo "  第 ${i}s 就绪:"; echo "$r" | head -c 200; echo; break; fi
done
echo
echo "=== 标签页 ==="
curl -s -m 5 http://127.0.0.1:9339/json/list 2>/dev/null | head -c 300
echo
echo "=== chrome 日志 ==="
head -5 /tmp/cdptest.log 2>/dev/null
