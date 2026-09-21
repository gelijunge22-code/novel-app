#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══════ 桥提供的能力（换个抓法） ═══════"
sed -n '540,700p' apk/src/com/nbapp/desk/MainActivity.java | grep -E "public .*\(" | sed 's/^\s*/  /'
echo
echo "═══════ 前端离线时靠什么 ═══════"
grep -nE "localStorage|indexedDB|IDBDatabase|caches\.|serviceWorker" frontend/js/*.js | head -10
echo
echo "═══════ api.js 的 base/请求方式 ═══════"
head -32 frontend/js/api.js
echo
echo "═══════ 最新截图 ═══════"
ls -t docs/前端截图/ | head -12
