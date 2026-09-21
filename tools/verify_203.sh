#!/bin/bash
cd /home/ubuntu/novel-app
BT=/home/ubuntu/android-sdk/build-tools/34.0.0
echo "═══ 1. 找到 2.0.3 的包 ═══"
ls -la apk/*.apk 2>/dev/null | awk '{printf "  %-28s %5.1fMB  %s %s %s\n",$9,$5/1048576,$6,$7,$8}'
cat apk/apk-version.json 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('  声明: v%s (code %s)  %.1fMB  %s' % (d['versionName'],d['versionCode'],d['size']/1048576,d['builtAt']))
print('  sha256:',d['sha256'][:40]+'...')
" 2>/dev/null
echo
echo "═══ 2. 从包里读真实版本号 ═══"
A=apk/手机写作台.apk
"$BT/aapt2" dump badging "$A" 2>/dev/null | grep -E "^package" | sed 's/^/  /'
echo
echo "═══ 3. 签名（必须和 2.0.2 一致才能覆盖） ═══"
"$BT/apksigner" verify --print-certs "$A" 2>/dev/null | grep -iE "SHA-256 digest" | head -2 | sed 's/^/  /'
echo "  2.0.2 的是: 428cb931438c673fb2660e9e781d35ac4e6a3215edf4d0cf2c961f02337e8aa0"
echo
echo "═══ 4. 前后端都进包了吗 ═══"
echo "  前端: $(unzip -l "$A" 2>/dev/null | grep -c 'assets/www/') 个"
echo "  后端: $(unzip -l "$A" 2>/dev/null | grep -cE 'python/server.*\.py|\.imy') 个"
echo
echo "═══ 5. 复制成英文名（发送用） ═══"
cp -f "$A" /home/ubuntu/NovelApp-2.0.3.apk && ls -la /home/ubuntu/NovelApp-2.0.3.apk | awk '{printf "  ✅ /home/ubuntu/NovelApp-2.0.3.apk  %.1fMB\n",$5/1048576}'
echo
echo "═══ 6. 线上下载口通不通 ═══"
curl -s -m 15 "http://[REDACTED-HOST]/novel/api/apk/version" 2>/dev/null | head -c 250
echo
curl -s -m 20 -o /dev/null -w "  下载口 http=%{http_code}\n" "http://[REDACTED-HOST]/novel/api/apk"
