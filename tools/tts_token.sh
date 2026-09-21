#!/usr/bin/env bash
cd /home/ubuntu/novel-app
PW=$(python3 -c "import json;print(json.load(open('/home/ubuntu/nbapp/config.json'))['app_password'])" 2>/dev/null)
[ -z "$PW" ] && PW=$(python3 -c "import json;print(json.load(open('data/config.json'))['app_password'])" 2>/dev/null)
SLUG=example-book
P='manuscript/第001章-荒原雪夜.md'
PE=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$P")

echo "═══ 拿 token（App 里就是这么拿的）═══"
TOK=$(curl -s -X POST "http://[REDACTED-HOST]/novel/api/app/login" -H 'Content-Type: application/json' -d "{\"password\":\"$PW\"}" | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
echo "  token 长度: ${#TOK}"

echo
echo "═══ A. 公网 + token（无 cookie）—— App 的真实姿势 ═══"
timeout 30 curl -s -o /tmp/c1 -w "  段落接口: HTTP %{http_code}  $(stat -c%s /tmp/c1)B\n" "http://[REDACTED-HOST]/novel/api/tts/segments?slug=$SLUG&path=$PE&token=$TOK"
head -c 150 /tmp/c1 | sed 's/^/    体: /'; echo
timeout 120 curl -s -o /tmp/c2.mp3 -w "  音频接口: HTTP %{http_code}  $(stat -c%s /tmp/c2.mp3)B\n" "http://[REDACTED-HOST]/novel/api/tts/seg?slug=$SLUG&path=$PE&i=0&token=$TOK"
xxd -l 8 /tmp/c2.mp3 | head -1 | sed 's/^/    头: /'

echo
echo "═══ B. 本地 8899 + token（无 cookie）═══"
timeout 120 curl -s -o /tmp/c3.mp3 -w "  音频接口: HTTP %{http_code}  $(stat -c%s /tmp/c3.mp3)B\n" "http://127.0.0.1:8899/api/tts/seg?slug=$SLUG&path=$PE&i=0&token=$TOK"
head -c 120 /tmp/c3.mp3 | sed 's/^/    体: /'; echo

echo
echo "═══ C. 对比：别的接口用 token 行不行（world）═══"
timeout 25 curl -s -o /tmp/c4 -w "  /api/world/entities + token: HTTP %{http_code}  $(stat -c%s /tmp/c4)B\n" "http://[REDACTED-HOST]/novel/api/world/entities?slug=$SLUG&limit=2&token=$TOK"

echo
echo "═══ D. security.py 里 token 是怎么认的 ═══"
grep -n "token" server/security.py | head -18 | cut -c1-165
