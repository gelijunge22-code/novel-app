#!/usr/bin/env bash
cd /home/ubuntu/novel-app
echo "═══ 1. Codex 活着吗、在干什么 ═══"
echo "  服务: $(systemctl --user is-active codex-goal.service)"
echo "  心跳: $(stat -c %y logs/codex-goal.log | cut -d. -f1)   现在: $(date '+%H:%M:%S')"
echo "  最后一次提交: $(git log -1 --pretty=format:'%ad %s' --date=format:'%m-%d %H:%M' | cut -c1-90)"
echo "  工作区改动文件数: $(git status --short | wc -l)"
echo
echo "  它最近在跑:"
grep -a "cmd:" logs/codex-goal.log | tail -3 | sed 's/.*cmd: //' | cut -c1-130 | sed 's/^/    /'
echo
echo "═══ 2. appearance 接口的全部路由（找'移除'用哪个）═══"
grep -n "@router" server/routers/appearance.py | cut -c1-120 | sed 's/^/  /'
echo
echo "═══ 3. 【急】撤销我刚才传的那张测试背景 ═══"
PW=$(python3 -c "import json;print(json.load(open('/home/ubuntu/nbapp/config.json'))['app_password'])" 2>/dev/null)
TOK=$(curl -s -X POST "http://127.0.0.1:8899/api/app/login" -H 'Content-Type: application/json' -d "{\"password\":\"$PW\"}" | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))")
B=http://127.0.0.1:8899; SLUG=example-book
for M in DELETE POST; do
  for U in "/api/appearance/bg?scope=global&slug=$SLUG" "/api/appearance/bg/clear?scope=global&slug=$SLUG" "/api/appearance/bg/del?scope=global&slug=$SLUG"; do
    code=$(curl -s -o /tmp/clr.json -w "%{http_code}" -X $M "$B$U&token=$TOK" -H "x-token: $TOK" 2>/dev/null)
    [ "$code" != "404" ] && [ "$code" != "405" ] && echo "  $M $U → HTTP $code  $(head -c 120 /tmp/clr.json)"
  done
done
echo "  撤完的状态:"
curl -s "$B/api/appearance/bg?slug=$SLUG&token=$TOK" | python3 -c "import sys,json;d=json.load(sys.stdin);print('    global.has =',d['global']['has'],' effective.has =',d['effective']['has'])" 2>/dev/null
echo "  目录文件数: $(ls data/appearance/ 2>/dev/null | wc -l)"
