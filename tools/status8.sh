#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 前端新增了什么 ═══"
ls -la frontend/js/ | awk '{print "  ",$9,$5"B"}'
echo
echo "  新文件 studio.js: $(wc -l < frontend/js/studio.js 2>/dev/null) 行"
echo "  index.html 新增面板:"
grep -oE 'id="screen-[a-z]+"|data-tab="[a-z]+"' frontend/index.html | sort -u
echo
echo "═══ 2. App 侧的本地桥 ═══"
grep -nE "JavascriptInterface|class JsBridge|@JavascriptInterface" apk/src/com/nbapp/desk/MainActivity.java | head -20
echo "  JsBridge 方法数: $(grep -c '@JavascriptInterface' apk/src/com/nbapp/desk/MainActivity.java)"
echo
echo "═══ 3. 安全：密钥有没有进 git ═══"
git -C . status --porcelain 2>/dev/null | grep -iE "keystore|\.jks|password" | head
git -C . ls-files 2>/dev/null | grep -iE "keystore|\.jks" | head
ls -la apk/keystore.txt apk/keystore.jks 2>/dev/null | awk '{print "  ",$9,$5"B"}'
echo "  .gitignore 里有吗: $(grep -iE "keystore|jks" .gitignore 2>/dev/null | head -3)"
echo
echo "═══ 4. 前端能不能离线（assets） ═══"
find apk/assets -type f 2>/dev/null | head -12
echo "  assets 里文件数: $(find apk/assets -type f 2>/dev/null | wc -l)"
echo
echo "═══ 5. api.js 有没有"可切换后端" ═══"
grep -nE "JsBridge|Android\.|local bridge|native|bridge" frontend/js/api.js | head -12
