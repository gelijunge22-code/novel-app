#!/bin/bash
cd /home/ubuntu/novel-app/apk
echo "═══ 1. 清单里 application 标签（关键：有没有指定 PyApplication） ═══"
grep -nE "<application|android:name=|PyApplication" AndroidManifest.xml | head -12
echo
echo "═══ 2. Java 里怎么启动 Python 的 ═══"
grep -nE "Python\.|AndroidPlatform|PyApplication|startPython|getInstance" src/com/nbapp/desk/*.java | head -20
echo
echo "═══ 3. python 入口 ═══"
cat src/main/python/main.py 2>/dev/null | head -20
echo
echo "═══ 4. ondevice 启动相关 Java ═══"
ls src/com/nbapp/desk/
echo
echo "═══ 5. gradle 里 chaquopy 配置 ═══"
grep -nE "chaquopy|python|sourceSets|abiFilters|version" build.gradle.kts | head -20
