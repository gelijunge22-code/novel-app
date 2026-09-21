#!/usr/bin/env bash
echo "═══ 1. 全盘找 slug/title 叫 "1" 的书 ═══"
for d in /home/ubuntu/novel-app/data/books /home/ubuntu/nbapp/data/books /home/ubuntu/nbapp/books /home/ubuntu/novel-app/books; do
  [ -d "$d" ] && echo "  ── $d:" && ls "$d" 2>/dev/null | head -8 | sed 's/^/      /'
done
echo
echo "═══ 2. nbapp（旧服务 8890）的书架 ═══"
PW=$(python3 -c "import json;print(json.load(open('/home/ubuntu/nbapp/config.json'))['app_password'])" 2>/dev/null)
TOK=$(curl -s -X POST "http://127.0.0.1:8890/api/app/login" -H 'Content-Type: application/json' -d "{\"password\":\"$PW\"}" | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
echo "  登录 token 长度: ${#TOK}"
curl -s "http://127.0.0.1:8890/api/shelf?token=$TOK" | head -c 500
echo
echo
echo "═══ 3. 所有 app.db 里 title 像 "1" 的 ═══"
find /home/ubuntu -name "app.db" -not -path "*/venv/*" 2>/dev/null | while read db; do
  echo "  ── $db"
  python3 -c "
import sqlite3,sys
try:
    c=sqlite3.connect('$db')
    for row in c.execute(\"select slug,title,word_count from book limit 10\"):
        print('      slug=%r title=%r words=%s' % row)
except Exception as e: print('      ', e)
" 2>/dev/null
done
echo
echo "═══ 4. 有没有"1"这种目录 ═══"
find /home/ubuntu -maxdepth 5 -type d -name "1" -not -path "*/node_modules/*" -not -path "*/venv/*" 2>/dev/null | head -8 | sed 's/^/  /'
