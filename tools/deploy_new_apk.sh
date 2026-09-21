#!/bin/bash
echo "=== 1. 线上下载口从哪里读包 ==="
grep -rnE "apk" /home/ubuntu/nbapp/server.py 2>/dev/null | grep -iE "path|dir|file|open" | head -8
echo
echo "=== 2. 找现成的 apk 文件位置 ==="
ls -la /home/ubuntu/nbapp/apk/ 2>/dev/null | head -6
ls -la /home/ubuntu/nbapp/*.apk 2>/dev/null | head -3
echo
echo "=== 3. 部署新包（2.0.2） ==="
NEW=/home/ubuntu/novel-app/apk/手机写作台.apk
for d in /home/ubuntu/nbapp/apk /home/ubuntu/nbapp/web/apk; do
  if [ -d "$d" ]; then
    cp -f "$NEW" "$d/手机写作台.apk"
    cp -f "$NEW" "$d/写作台.apk" 2>/dev/null
    echo "  ✅ 复制到 $d"
    ls -la "$d" | head -5
  fi
done
echo
echo "=== 4. 线上版本接口报什么 ==="
sleep 2
curl -s -m 10 http://127.0.0.1:8890/api/apk/version 2>/dev/null | head -c 250
echo
echo
echo "=== 5. 公网下载测一下 ==="
curl -s -m 20 -o /dev/null -w "  http=%{http_code}  大小=%{size_download}B\n" http://[REDACTED-HOST]/nbapp/apk
