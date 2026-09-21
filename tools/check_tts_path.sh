#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. TTS 的接口路由是什么 ═══"
grep -rn "tts" server/*.py 2>/dev/null | grep -E "route|@app|def " | head -12 | cut -c1-160
echo
echo "═══ 2. 接口清单里跟 tts/voice 有关的 ═══"
grep -rn "tts\|voice" server/routes*.py server/api*.py server/main*.py 2>/dev/null | grep -oE "['\"]/[^'\"]*tts[^'\"]*['\"]|['\"]/[^'\"]*voice[^'\"]*['\"]" | sort -u | head -12 | sed 's/^/  /'
echo
echo "═══ 3. 本地后端（8899）TTS 通不通 ═══"
for u in "/api/tts/voices" "/api/tts?text=测试&voice=zh-CN-YunxiNeural" "/api/tts/speak?text=测试" "/api/voice/list" "/api/tts/audio?text=测试"; do
  code=$(timeout 20 curl -s -o /tmp/ttsout.bin -w "%{http_code}" "http://127.0.0.1:8899$u" 2>/dev/null)
  size=$(stat -c%s /tmp/ttsout.bin 2>/dev/null || echo 0)
  echo "  127.0.0.1:8899$u → HTTP $code  ${size}B"
done
echo
echo "═══ 4. 公网入口（App 实际走的） ═══"
for u in "/api/tts/voices" "/api/tts?text=测试&voice=zh-CN-YunxiNeural"; do
  code=$(timeout 25 curl -s -o /tmp/ttsout2.bin -w "%{http_code}" "http://<你的服务器地址>/novel$u" 2>/dev/null)
  size=$(stat -c%s /tmp/ttsout2.bin 2>/dev/null || echo 0)
  echo "  <你的服务器地址>/novel$u → HTTP $code  ${size}B"
done
echo
echo "═══ 5. 有没有反代/中间层拦截 ═══"
grep -rn "tts" /etc/caddy/Caddyfile 2>/dev/null | head -5 | cut -c1-150
echo
echo "═══ 6. 后端日志里 TTS 的报错 ═══"
ls -t logs/*.log 2>/dev/null | head -3 | while read f; do
  echo "  ── $f"
  grep -ai "tts\|voice\|edge" "$f" 2>/dev/null | tail -5 | cut -c1-150 | sed 's/^/     /'
done
