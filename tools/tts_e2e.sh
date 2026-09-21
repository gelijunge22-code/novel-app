#!/usr/bin/env bash
# 亲测 TTS 全链路：登录 → 取段 → 拿音频（本地 + 公网各一遍）
cd /home/ubuntu/novel-app
PW=$(python3 -c "import json;print(json.load(open('/home/ubuntu/nbapp/config.json'))['app_password'])" 2>/dev/null)
if [ -z "$PW" ]; then PW=$(python3 -c "import json;print(json.load(open('data/config.json'))['app_password'])" 2>/dev/null); fi
SLUG=example-book

test_one() {
  local BASE="$1" NAME="$2"
  local JAR=/tmp/tts_jar_$NAME.txt
  rm -f "$JAR"
  echo "───── $NAME : $BASE ─────"
  # 1 登录
  local LR=$(timeout 25 curl -s -c "$JAR" -X POST "$BASE/api/app/login" -H 'Content-Type: application/json' -d "{\"password\":\"$PW\"}" -w "\n%{http_code}")
  echo "  登录: HTTP $(echo "$LR" | tail -1)  体: $(echo "$LR" | head -1 | cut -c1-90)"
  # 2 章节目录
  local CH=$(timeout 25 curl -s -b "$JAR" "$BASE/api/files?slug=$SLUG" 2>/dev/null | head -c 300)
  echo "  文件列表: $(echo "$CH" | cut -c1-160)"
  # 3 段落数
  local SEG=$(timeout 30 curl -s -b "$JAR" "$BASE/api/tts/segments?slug=$SLUG&path=第001章.md" -w "|%{http_code}")
  echo "  段落: $(echo "$SEG" | cut -c1-160)"
  # 4 真取第 0 段音频
  local OUT=/tmp/tts_$NAME.mp3
  local CODE=$(timeout 90 curl -s -b "$JAR" -o "$OUT" -w "%{http_code}" "$BASE/api/tts/seg?slug=$SLUG&path=第001章.md&i=0" 2>/dev/null)
  local SZ=$(stat -c%s "$OUT" 2>/dev/null || echo 0)
  echo "  音频: HTTP $CODE  ${SZ}B"
  if [ "$SZ" -gt 0 ]; then
    echo "  文件头: $(xxd -l 12 "$OUT" 2>/dev/null | head -1)"
    timeout 20 ffprobe -v error -show_entries format=duration,format_name -of default=nw=1 "$OUT" 2>/dev/null | sed 's/^/    /'
  fi
  echo
}

test_one "http://127.0.0.1:8899" local
test_one "http://[REDACTED-HOST]/novel" public
