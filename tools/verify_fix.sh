#!/bin/bash
BT=/home/ubuntu/android-sdk/build-tools/34.0.0
A=/home/ubuntu/novel-app/apk/手机写作台.apk
echo "═══ ① 包里的清单有没有 PyApplication（关键验证） ═══"
$BT/aapt2 dump xmltree --file AndroidManifest.xml $A 2>/dev/null | grep -iE "application|chaquo|PyApplication" | head -8
echo
echo "═══ ② 直接搜二进制清单里的类名 ═══"
strings $A | grep -i "PyApplication" | head -3 || echo "  (在压缩的清单里，用上面那条看)"
echo
echo "═══ ③ 版本 / 签名 ═══"
$BT/aapt2 dump badging $A 2>/dev/null | grep -E "^package"
$BT/apksigner verify --print-certs $A 2>/dev/null | grep -iE "SHA-256 digest" | head -1
echo
echo "═══ ④ 架构 ═══"
$BT/aapt2 dump badging $A 2>/dev/null | grep -E "native-code"
echo
echo "═══ ⑤ 包内有没有 chaquopy 的 Android 类 ═══"
$BT/dexdump -f $A 2>/dev/null | grep -oE "Lcom/chaquo/python/[A-Za-z/]*" | sort -u | head -8
