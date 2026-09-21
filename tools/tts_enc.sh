#!/usr/bin/env bash
cd /home/ubuntu/novel-app
PW=$(python3 -c "import json;print(json.load(open('/home/ubuntu/nbapp/config.json'))['app_password'])" 2>/dev/null)
[ -z "$PW" ] && PW=$(python3 -c "import json;print(json.load(open('data/config.json'))['app_password'])" 2>/dev/null)
SLUG=example-book
BASE=http://127.0.0.1:8899
JAR=/tmp/tts_jar2.txt
rm -f "$JAR"
curl -s -c "$JAR" -X POST "$BASE/api/app/login" -H 'Content-Type: application/json' -d "{\"password\":\"$PW\"}" -o /dev/null

echo "═══ 1. 先看这本书真实文件名 ═══"
ls data/books/$SLUG/ 2>/dev/null | head -6 | sed 's/^/  /'

echo
echo "═══ 2. 原始中文路径（不编码）—— 我猜的元凶 ═══"
timeout 20 curl -s -b "$JAR" -o /tmp/a1 -w "  结果: HTTP %{http_code}  $(stat -c%s /tmp/a1 2>/dev/null)B\n" "$BASE/api/tts/segments?slug=$SLUG&path=第001章.md" 2>&1
head -c 80 /tmp/a1 | sed 's/^/    体: /'; echo

echo
echo "═══ 3. 百分号编码后的中文路径 ═══"
ENC=$(python3 -c "import urllib.parse;print(urllib.parse.quote('第001章.md'))")
echo "  编码后: $ENC"
timeout 20 curl -s -b "$JAR" -o /tmp/a2 -w "  结果: HTTP %{http_code}  $(stat -c%s /tmp/a2 2>/dev/null)B\n" "$BASE/api/tts/segments?slug=$SLUG&path=$ENC" 2>&1
head -c 200 /tmp/a2 | sed 's/^/    体: /'; echo

echo
echo "═══ 4. 编码后取音频 ═══"
timeout 90 curl -s -b "$JAR" -o /tmp/a3.mp3 -w "  结果: HTTP %{http_code}  $(stat -c%s /tmp/a3.mp3 2>/dev/null)B\n" "$BASE/api/tts/seg?slug=$SLUG&path=$ENC&i=0" 2>&1
xxd -l 8 /tmp/a3.mp3 2>/dev/null | head -1 | sed 's/^/    头: /'
timeout 20 ffprobe -v error -show_entries format=duration -of default=nw=1 /tmp/a3.mp3 2>/dev/null | sed 's/^/    /'

echo
echo "═══ 5. 前端发请求时到底编不编码 ═══"
grep -rn "tts/seg\|tts/segments\|encodeURIComponent" frontend/js/reader.js 2>/dev/null | head -12 | cut -c1-165
