#!/bin/bash
BT=/home/ubuntu/android-sdk/build-tools/34.0.0
echo "═══════ 签名证书指纹对比（这才是"装不上"的关键） ═══════"
for f in /home/ubuntu/novel-app/apk/手机写作台.apk /home/ubuntu/nbapp/apk/手机写作台.apk; do
  echo "--- $(basename $(dirname $f))/$(basename $f) ---"
  $BT/apksigner verify --print-certs "$f" 2>/dev/null | grep -iE "SHA-256 digest|SHA-256.*certificate" | head -2
done
echo
echo "═══════ minSdk / 设备兼容 ═══════"
for f in /home/ubuntu/novel-app/apk/手机写作台.apk /home/ubuntu/nbapp/apk/手机写作台.apk; do
  echo -n "  $(basename $f): "
  $BT/aapt2 dump badging "$f" 2>/dev/null | grep -E "sdkVersion|targetSdkVersion|native-code" | tr '\n' ' '
  echo
done
echo
echo "═══════ 新包里的原生库架构 ═══════"
unzip -l /home/ubuntu/novel-app/apk/手机写作台.apk 2>/dev/null | grep -oE "lib/[a-z0-9_-]+/" | sort -u
