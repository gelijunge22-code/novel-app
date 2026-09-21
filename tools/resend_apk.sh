#!/bin/bash
cd /home/ubuntu/novel-app
# 换成纯英文名，避免发送失败
cp -f apk/手机写作台.apk /home/ubuntu/NovelApp-2.0.2.apk
ls -la /home/ubuntu/NovelApp-2.0.2.apk | awk '{printf "  ✅ /home/ubuntu/NovelApp-2.0.2.apk  %.1fMB\n",$5/1048576}'
echo
echo "=== 在线下载口（备用）==="
echo "  线上包版本:"
curl -s -m 10 http://127.0.0.1:8890/api/apk/version 2>/dev/null | head -c 200
echo
curl -s -m 10 -o /dev/null -w "  http://<你的服务器地址>/nbapp/apk  http=%{http_code} 大小=%{size_download}B\n" http://<你的服务器地址>/nbapp/apk
