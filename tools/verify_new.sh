#!/bin/bash
BT=/home/ubuntu/android-sdk/build-tools/34.0.0
A=/home/ubuntu/novel-app/apk/手机写作台.apk
echo "═══════ ① 版本 ═══════"
$BT/aapt2 dump badging $A 2>/dev/null | grep -E "^package"
echo
echo "═══════ ② 签名指纹（必须 = 428cb931…8aa0） ═══════"
$BT/apksigner verify --print-certs $A 2>/dev/null | grep -iE "SHA-256 digest" | head -1
echo "  旧包参照: Signer #1 certificate SHA-256 digest: 428cb931438c673fb2660e9e781d35ac4e6a3215edf4d0cf2c961f02337e8aa0"
echo
echo "═══════ ③ 签名校验结果 ═══════"
$BT/apksigner verify $A 2>&1 | head -3 | sed 's/^/  /'
echo
echo "═══════ ④ 支持的芯片架构 ═══════"
$BT/aapt2 dump badging $A 2>/dev/null | grep -E "native-code"
echo "  包内 lib 目录:"
unzip -l $A 2>/dev/null | grep -oE "lib/[a-z0-9_-]+/" | sort -u | sed 's/^/    /'
echo
echo "═══════ ⑤ 后端和前端还在不在 ═══════"
echo "  前端文件: $(unzip -l $A 2>/dev/null | grep -c 'assets/www')"
echo "  Python 运行时: $(unzip -l $A 2>/dev/null | grep -c 'libpython')"
echo "  后端归档 app.imy: $(unzip -l $A 2>/dev/null | grep -c 'chaquopy/app.imy')"
echo
echo "═══════ ⑥ 大小 / 哈希 ═══════"
ls -la $A | awk '{print "  ",$5"B"}'
sha256sum $A | cut -c1-40 | sed 's/^/  /'
