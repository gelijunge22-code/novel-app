#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 它最近在干什么 ═══"
grep "它说:" logs/codex-goal.log | tail -6 | cut -c1-260
echo
echo "═══ 最近的构建相关命令 ═══"
grep -oE '"command": "[^"]{0,150}' logs/codex-goal.log | grep -iE "gradle|build|apk|sign|keytool|apksigner" | tail -6
echo
echo "═══ 当前包（有没有重打出来） ═══"
ls -la apk/手机写作台.apk apk/build/outputs/apk/release/*.apk 2>/dev/null | awk '{print "  ",$9,$5"B",$6,$7,$8}'
echo
echo "═══ 版本号 ═══"
cat apk/apk-version.json 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);print('  ',d.get('versionName'),'code',d.get('versionCode'),'|',d.get('builtAt'))" 2>/dev/null
grep -nE "versionCode|versionName" apk/version.txt apk/build.gradle.kts 2>/dev/null | head -6
echo
echo "═══ keystore 有没有换回原版 ═══"
md5sum apk/keystore.jks /home/ubuntu/nbapp/apk/keystore.jks 2>/dev/null
echo
echo "═══ 32 位库加了没 ═══"
ls apk/libs/ 2>/dev/null | grep -ciE "armeabi|armv7" | sed 's/^/  armeabi-v7a wheel 数: /'
ls apk/libs/ 2>/dev/null | head -4
echo
echo "═══ 打包进程在跑吗 ═══"
pgrep -af "gradle|java" | grep -v pgrep | head -3 | cut -c1-140