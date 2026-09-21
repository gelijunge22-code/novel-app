#!/bin/bash
cd /home/ubuntu/novel-app
BT=/home/ubuntu/android-sdk/build-tools/34.0.0
echo "═══ 1. 2.0.4 包核实 ═══"
python3 -c "
import json;d=json.load(open('apk/apk-version.json'))
print('  声明: v%s (code %s)  %.1fMB  %s' % (d['versionName'],d['versionCode'],d['size']/1048576,d['builtAt']))
print('  sha256:',d['sha256'][:40]+'...')
" 2>/dev/null
A=apk/手机写作台.apk
"$BT/aapt2" dump badging "$A" 2>/dev/null | grep -E "^package" | sed 's/^/  包内: /'
"$BT/apksigner" verify --print-certs "$A" 2>/dev/null | grep -iE "SHA-256 digest" | head -1 | sed 's/^/  签名: /'
echo "  期望签名: 428cb931438c673fb2660e9e781d35ac4e6a3215edf4d0cf2c961f02337e8aa0"
echo
echo "  线上下载口:"
curl -s -m 12 "http://<你的服务器地址>/novel/api/apk/version" 2>/dev/null | head -c 220
echo
echo
echo "═══ 2. 前端大改开工了吗（两个关键指标）═══"
b=$(cat frontend/index.html frontend/js/*.js frontend/css/*.css 2>/dev/null | wc -c)
l=$(cat frontend/index.html frontend/js/*.js frontend/css/*.css 2>/dev/null | wc -l)
echo "  前端体积: $b 字节 / $l 行    (基线 726571/12898  目标 1453142/25796)"
echo "  完成度: $(python3 -c "print(round($b/1453142*100,1))")%"
echo
echo "  ── 进度文档里有没有「前端大改 · 第 N 屏」:"
grep -nE "前端大改" docs/进度.md 2>/dev/null | head -6 | cut -c1-150 | sed 's/^/     /'
echo
echo "═══ 3. 它现在在干什么 ═══"
echo "  心跳: $(stat -c %y logs/codex-goal.log | cut -d. -f1)"
grep -a "cmd:" logs/codex-goal.log | tail -3 | sed 's/.*cmd: //' | cut -c1-135 | sed 's/^/  /'
echo
echo "═══ 4. 最近 20 分钟改的前端文件 ═══"
find frontend -newermt '-20 minutes' -type f 2>/dev/null | while read f; do printf "  %-28s %s\n" "${f#frontend/}" "$(stat -c %y "$f" | cut -d. -f1)"; done
