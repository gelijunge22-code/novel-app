#!/usr/bin/env bash
cd /home/ubuntu/novel-app
PW=$(python3 -c "import json;print(json.load(open('/home/ubuntu/nbapp/config.json'))['app_password'])" 2>/dev/null)
[ -z "$PW" ] && PW=$(python3 -c "import json;print(json.load(open('data/config.json'))['app_password'])" 2>/dev/null)
SLUG=example-book
P='manuscript/第001章-荒原雪夜.md'
PE=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$P")
BASE=http://127.0.0.1:8899
JAR=/tmp/tts_j3.txt; rm -f $JAR
curl -s -c $JAR -X POST "$BASE/api/app/login" -H 'Content-Type: application/json' -d "{\"password\":\"$PW\"}" -o /dev/null

echo "═══ A. 正确路径 · 原始中文（不编码）═══"
timeout 20 curl -s -b $JAR -o /tmp/b1 -w "  HTTP %{http_code}\n" "$BASE/api/tts/segments?slug=$SLUG&path=$P"
head -c 200 /tmp/b1 | sed 's/^/    体: /'; echo

echo
echo "═══ B. 正确路径 · 百分号编码（浏览器/WebView 实际会这么发）═══"
timeout 20 curl -s -b $JAR -o /tmp/b2 -w "  HTTP %{http_code}\n" "$BASE/api/tts/segments?slug=$SLUG&path=$PE"
head -c 220 /tmp/b2 | sed 's/^/    体: /'; echo

echo
echo "═══ C. 取第 0 段音频（编码版）═══"
timeout 120 curl -s -b $JAR -o /tmp/b3.mp3 -w "  HTTP %{http_code}  $(stat -c%s /tmp/b3.mp3 2>/dev/null)B\n" "$BASE/api/tts/seg?slug=$SLUG&path=$PE&i=0"
xxd -l 8 /tmp/b3.mp3 | head -1 | sed 's/^/    头: /'
timeout 20 ffprobe -v error -show_entries format=duration -of default=nw=1 /tmp/b3.mp3 2>/dev/null | sed 's/^/    /'

echo
echo "═══ D. 公网入口同样来一遍 ═══"
timeout 120 curl -s -b $JAR -o /tmp/b4.mp3 -w "  HTTP %{http_code}  $(stat -c%s /tmp/b4.mp3 2>/dev/null)B\n" "http://[REDACTED-HOST]/novel/api/tts/seg?slug=$SLUG&path=$PE&i=0"
xxd -l 8 /tmp/b4.mp3 | head -1 | sed 's/^/    头: /'

echo
echo "═══ E. 前端拼 URL 的地方（reader.js 里的 tts 请求）═══"
grep -n "seg\b\|'api/tts\|tts/seg\|absUrl\|API.media\|encodeURI" frontend/js/reader.js | grep -i "tts\|seg" | head -12 | cut -c1-170
