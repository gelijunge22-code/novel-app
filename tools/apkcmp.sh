#!/bin/bash
BT=/home/ubuntu/android-sdk/build-tools/34.0.0
NEW=/home/ubuntu/novel-app/apk/手机写作台.apk
echo "═══════ 新包（NovelApp） ═══════"
$BT/aapt2 dump badging $NEW 2>/dev/null | grep -E "^package" 
echo "  签名:"
$BT/apksigner verify --print-certs $NEW 2>/dev/null | grep -E "Signer #1 (certificate DN|SHA-256)" | head -3
echo
echo "═══════ 旧包（之前装的） ═══════"
for f in /home/ubuntu/nbapp/apk/手机写作台.apk /home/ubuntu/nbapp/apk/备份-1.2-手机写作台.apk; do
  [ -f "$f" ] || continue
  echo "--- $f ---"
  $BT/aapt2 dump badging "$f" 2>/dev/null | grep -E "^package"
  $BT/apksigner verify --print-certs "$f" 2>/dev/null | grep -E "Signer #1 (certificate DN|SHA-256)" | head -2
done
echo
echo "═══════ 结论 ═══════"
echo -n "新包包名: "; $BT/aapt2 dump badging $NEW 2>/dev/null | grep -oE "name='[^']+'" | head -1
echo -n "旧包包名: "; $BT/aapt2 dump badging /home/ubuntu/nbapp/apk/手机写作台.apk 2>/dev/null | grep -oE "name='[^']+'" | head -1
