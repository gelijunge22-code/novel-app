#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. App 里的后端选择逻辑（deterministic chooser） ═══"
grep -rnE "chooser|chooseBackend|backendMode|ondevice|on-device|本机服务|localBackend|useLocal" \
  apk/src/com/nbapp/desk/*.java 2>/dev/null | head -12
echo
echo "═══ 2. 安卓壳里怎么决定连哪 ═══"
grep -rnE "127.0.0.1|8899|localhost|http://" apk/src/com/nbapp/desk/*.java 2>/dev/null | head -12
echo
echo "═══ 3. 前端的地址解析 ═══"
grep -rnE "API_BASE|apiBase|baseUrl|127.0.0.1|8899" apk/assets/www/js/api.js 2>/dev/null | head -12
echo
echo "═══ 4. 服务器地址配置从哪读 ═══"
grep -rnE "server_url|serverUrl|apiBase|remote" apk/assets/www/js/*.js 2>/dev/null | head -10
echo
echo "═══ 5. 有没有"刚打开就请求"的逻辑 ═══"
grep -rnE "bookctx|currentBook|/api/projects|/api/books" apk/assets/www/js/bookctx.js 2>/dev/null | head -12
echo
echo "═══ 6. 服务器上后端在跑吗 ═══"
systemctl --user is-active novelapp.service 2>/dev/null | sed 's/^/  novelapp: /'
curl -s -m 8 http://127.0.0.1:8899/api/app/info 2>/dev/null | head -c 200
echo
echo "═══ 7. 服务器后端看到的书 ═══"
curl -s -m 10 http://127.0.0.1:8899/api/projects 2>/dev/null | head -c 300
echo
curl -s -m 10 http://127.0.0.1:8899/api/books 2>/dev/null | head -c 300
