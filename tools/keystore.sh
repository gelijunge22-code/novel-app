#!/bin/bash
echo "═══ 原签名密钥在不在（这是能否修好的前提） ═══"
ls -la /home/ubuntu/nbapp/apk/keystore.jks /home/ubuntu/nbapp/apk/keystore.txt 2>/dev/null | awk '{print "  ",$9,$5"B"}'
echo
echo "═══ 它的口令引用方式（build.sh 里怎么读的） ═══"
grep -nE "keystore|KS_PASS|storepass|keypass" /home/ubuntu/nbapp/apk/build.sh 2>/dev/null | sed 's/=.*/=***/' | head -8
echo
echo "═══ 新工程里有没有拷过去 ═══"
ls -la /home/ubuntu/novel-app/apk/keystore.jks 2>/dev/null | awk '{print "  ",$9,$5"B"}'
echo
echo "═══ 两个 keystore 是同一把吗（比指纹） ═══"
for k in /home/ubuntu/nbapp/apk/keystore.jks /home/ubuntu/novel-app/apk/keystore.jks; do
  [ -f "$k" ] || continue
  echo -n "  $(dirname $k | xargs basename): "
  keytool -list -v -keystore "$k" -storepass "$(cat $(dirname $k)/keystore.txt 2>/dev/null | head -1)" 2>/dev/null | grep -iE "SHA256:" | head -1 | sed 's/.*SHA256: //' | cut -c1-40
done
