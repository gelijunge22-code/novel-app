#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══════ 1. 版本变化 ═══════"
python3 -c "
import json;d=json.load(open('apk/apk-version.json'))
print(' 当前:', d.get('versionName'),'code',d.get('versionCode'),'|',d.get('size'),'字节 |',d.get('builtAt'))"
echo "  旧版对比: v1.2=149461B(纯壳,前端不打包) → v1.5=285872B → 现在"
echo
echo "═══════ 2. APK 里到底装了什么 ═══════"
echo "  总条目: $(unzip -l apk/手机写作台.apk 2>/dev/null | tail -1 | awk '{print $2}')"
echo "  assets/www (前端): $(unzip -l apk/手机写作台.apk 2>/dev/null | grep -c 'assets/www') 个文件"
echo "  有没有本地后端(js 实现的 API):"
unzip -l apk/手机写作台.apk 2>/dev/null | grep -iE "assets/.*(local|core|engine|db|store)" | head -10
echo "  APK 里所有 assets 目录:"
unzip -l apk/手机写作台.apk 2>/dev/null | grep -oE "assets/[a-z-]+/" | sort -u
echo
echo "═══════ 3. 前端有没有"本地模式"分支 ═══════"
grep -nE "Android\.|JsBridge|localMode|LOCAL|本地模式|bridge" frontend/js/api.js | head -16
echo
echo "═══════ 4. App 那个桥到底提供什么能力 ═══════"
grep -A2 "@JavascriptInterface" apk/src/com/nbapp/desk/MainActivity.java | grep -oE "public [a-zA-Z<>\[\] ]+ [a-zA-Z]+\(" | sed 's/^public //' | head -20
echo
echo "═══════ 5. 有没有本地数据库 ═══════"
find apk -name '*.db' -o -name '*.sqlite' -o -name '*.sql' 2>/dev/null | head -5
grep -nE "SQLiteOpenHelper|SQLiteDatabase" apk/src/com/nbapp/desk/MainActivity.java | head -3
