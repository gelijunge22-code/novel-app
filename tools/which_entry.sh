#!/usr/bin/env bash
cd /home/ubuntu/novel-app
PW=$(python3 -c "import json;print(json.load(open('/home/ubuntu/nbapp/config.json'))['app_password'])" 2>/dev/null)
echo "=== 两个入口各自的 selfcheck 接口 ==="
for B in "http://[REDACTED-HOST]/novel" "http://[REDACTED-HOST]/nbapp"; do
  TOK=$(curl -s -X POST "$B/api/app/login" -H 'Content-Type: application/json' -d "{\"password\":\"$PW\"}" | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
  code=$(curl -s -o /tmp/x.json -w "%{http_code}" "$B/api/tts/selfcheck?slug=x&path=y&token=$TOK" 2>/dev/null)
  b1=$(curl -s -o /dev/null -w "%{http_code}" "$B/api/tts/segments?slug=x&path=y&token=$TOK" 2>/dev/null)
  echo "  $B"
  echo "     /api/tts/selfcheck → HTTP $code   $(head -c 70 /tmp/x.json)"
  echo "     /api/tts/segments  → HTTP $b1"
  echo "     前端有没有 ttsdiag(听书自检) 这个新东西: $(curl -s "$B/js/reader.js" | grep -c 'ttsdiag' 2>/dev/null)"
  echo
done
echo "=== 两个入口的前端各自多大/多新 ==="
for B in "http://[REDACTED-HOST]/novel" "http://[REDACTED-HOST]/nbapp"; do
  sz=$(curl -s "$B/js/reader.js" | wc -c)
  echo "  $B/js/reader.js  = ${sz} 字节"
done
